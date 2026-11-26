from __future__ import annotations

import argparse
import base64
import hashlib
import io
import importlib.util
import json
import math
from contextlib import contextmanager, nullcontext
from functools import lru_cache
import mimetypes
import os
import re
import shutil
import sys
import subprocess
import threading
import time
import uuid
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator

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
import custom_image_pipeline as custom_image
import custom_image_registry
import custom_image_download
import flux2_klein_text_encoder
import lora_download
from generation_worker import GenerationWorker, GenerationCancelled, tame_pony_inference_loop, custom_image_inference_loop
from tts_generation_worker import TtsGenerationWorker
from text_generation_process import TextGenerationProcess, TextWorkerError
from text_model_registry import TextModelRegistry
from text_model_download import DEFAULT_MODEL_ID as DEFAULT_TEXT_MODEL_ID
from text_model_download import catalog as text_model_catalog, install_model as install_text_model, model_files as text_model_files
from text_model_download import model_download_details as text_model_download_details
from text_model_download import PREPARING_MODEL_FILES, TextModelDownloadPaused, check_download_pause, has_partial_download
from text_model_download import managed_download_id, remove_download as remove_text_model_download
from gguf_metadata import is_projector, read_metadata as read_gguf_metadata
from gguf_runtime import RUNTIME_PLATFORM_ERROR, apple_silicon, runtime_supported as gguf_runtime_supported
from chat_image_tools import CHAT_IMAGE_SIZE, IMAGE_MODEL_PRIORITY, IMAGE_TOOL, chat_image_overrides, image_tool_prompt
from chat_documents import MAX_DOCUMENT_BYTES, ChatDocumentsUnavailable, document_ids, read_document_source, retrieve_passages, store_document
from chat_context import DEFAULT_CONTEXT_SIZE, validate_context_size, validate_gguf_load_options
from tts_model_download import model_download_details as tts_model_download_details
from tts_model_download import model_ready as tts_export_ready, require_fresh_install_space as require_tts_install_space

GENERATION_WORKER = GenerationWorker()
TAME_PONY_GENERATION_WORKER = GenerationWorker(target=tame_pony_inference_loop)
CUSTOM_IMAGE_GENERATION_WORKER = GenerationWorker(target=custom_image_inference_loop)
TTS_GENERATION_WORKER = TtsGenerationWorker()
TEXT_GENERATION_WORKER = TextGenerationProcess()
from model_manager import ModelManager, remove_tree
from model_catalog import APPLE_IMAGE_ID, APPLE_IMAGE_SPEC, INTEL_MEDIA_CATALOG, model_spec
import apple_image
from intel_media import IntelMedia, PLATFORM_NOTE as INTEL_MEDIA_PLATFORM_NOTE, SANA_RUNTIME_RESERVE_BYTES, VIDEO_ID, Z_IMAGE_ID, supported as intel_media_supported
from video_jobs import VideoJobs
from PIL import ImageOps
import gallery_store
from media_http import byte_range
import storage_manager
from device_adapters import APPLE_GPU, CPU, INTEL_GPU, NVIDIA_GPU, device_label, normalize_device
from qwen21_turbo_download import MINIMUM_FREE_BYTES as QWEN_TURBO_DISK_RESERVE
from qwen21_turbo_download import download_model as download_qwen_turbo_model


OUTPUTS = ROOT / "outputs"
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
CUSTOM_IMAGE_DOWNLOAD = custom_image_download.CustomImageDownloadManager(MODELS_DIR)
CACHE_DIR = ROOT / ".cache"
TTS_MODEL_ROOT = Path(os.environ.get("FERN_TTS_MODEL_ROOT", MODELS_DIR / "qwen3-tts")).resolve()
TTS_ENV = Path(os.environ.get("FERN_TTS_ENV", ROOT / ".venv-qwen3-tts")).resolve()
TEXT_MODEL_REGISTRY = TextModelRegistry(Path(os.environ.get("FERN_TEXT_MODEL_REGISTRY", DATA_DIR / "text-models.json")))
TEXT_MODEL_ROOT = Path(os.environ.get("FERN_TEXT_MODEL_ROOT", MODELS_DIR / "text")).resolve()
TEXT_MODEL_INSTALL_LOCK = threading.Lock()
TEXT_MODEL_INSTALL: dict[str, Any] = {"id": None, "status": "idle", "phase": None, "error": None}
TEXT_MODEL_DOWNLOAD_PAUSE: threading.Event | None = None
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
INTEL_MEDIA = IntelMedia(ROOT)
VIDEO_JOBS = VideoJobs(INTEL_MEDIA, CACHE_DIR, DATA_DIR, OUTPUTS)
MODEL_MANAGER = ModelManager(MODELS_DIR, prepare=INTEL_MEDIA.prepare_install, preflight=INTEL_MEDIA.preflight_install)
KLEIN_TEXT_ENCODER_MANAGER = flux2_klein_text_encoder.KleinTextEncoderManager(
    flux2.MODELS_ROOT, DATA_DIR / "flux2-klein-4b-text-encoder.json"
)
LORA_DOWNLOAD = lora_download.LoraDownloadManager(DATA_DIR / "loras")
FLUX3_SETUP_LOCK = threading.Lock()
FLUX3_SETUP_STATE: dict[str, Any] = {"status": "idle", "phase": None, "error": None, "logs": []}
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
TEXT_JOB_CHANGED = threading.Condition(TEXT_JOB_LOCK)
TEXT_JOB_REVISION = 0
TEXT_JOB_STREAMS = threading.BoundedSemaphore(4)
TEXT_JOB_STREAM_INTERVAL = 0.05
TEXT_JOB_STREAM_HEARTBEAT = 8
TEXT_ADMISSION_LOCK = threading.Lock()
TEXT_PENDING_STOPS: dict[tuple[str, str], float] = {}
TEXT_PENDING_STOP_SECONDS = 300
TEXT_PENDING_STOP_LIMIT = 256
# Serialize admission and cancellation across modalities.
JOB_ADMISSION_LOCK = threading.RLock()
CHAT_IMAGE_UPLOAD_SLOTS = threading.BoundedSemaphore(2)
CHAT_DOCUMENT_UPLOAD_LOCK = threading.Lock()
CHAT_ATTACHMENT_STORAGE_REVISION = 0
TEXT_CANCEL_EVENT: threading.Event | None = None
TEXT_JOB: dict[str, Any] = {
    "id": None, "threadId": None, "modelId": None, "status": "idle",
    "phase": None, "partialText": "", "partialReasoning": "", "startedAt": None, "finishedAt": None,
    "result": None, "image": None, "error": None, "errorCode": None, "failureDiagnostics": None, "residentModel": None,
    "modelLoad": False, "unavailableDocumentIds": None,
}


def text_model_install_running() -> bool:
    with TEXT_MODEL_INSTALL_LOCK:
        return TEXT_MODEL_INSTALL.get("status") in ("downloading", "pausing", "preparing")


def run_text_model_install(model_id: str, job_id: str, pause: threading.Event, repair: bool = False) -> None:
    def progress(phase: str) -> None:
        with TEXT_MODEL_INSTALL_LOCK:
            if TEXT_MODEL_INSTALL.get("id") == job_id:
                check_download_pause(pause)
                preparing = phase == PREPARING_MODEL_FILES or TEXT_MODEL_INSTALL["status"] == "preparing"
                TEXT_MODEL_INSTALL.update(status="preparing" if preparing else "downloading", phase=phase)
    try:
        check_download_pause(pause)
        TEXT_GENERATION_WORKER.close()
        folder = install_text_model(model_id, TEXT_MODEL_ROOT, progress, pause=pause, repair=repair)
        model_path, projector_path = text_model_files(folder, text_model_catalog()[model_id])
        model = TEXT_MODEL_REGISTRY.add(str(model_path), str(projector_path) if projector_path else None)
        fields = {"status": "complete", "phase": "Repaired and verified." if repair else "Installed and verified.",
                  "error": None, "modelId": model_id if repair else model["id"]}
    except TextModelDownloadPaused:
        fields = {"status": "paused", "phase": "Repair paused." if repair else "Download paused.", "error": None}
    except Exception as error:
        fields = {"status": "failed", "phase": None, "error": str(error)[:1000]}
    with TEXT_MODEL_INSTALL_LOCK:
        if TEXT_MODEL_INSTALL.get("id") == job_id:
            TEXT_MODEL_INSTALL.update(fields)
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


def qwen_turbo_setup_unavailable() -> str | None:
    if sys.platform == "linux":
        return "Qwen Image Turbo setup is unavailable in the Linux beta. Choose a FLUX.2 Klein model."
    return None


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
    download_bytes = qwen_turbo_quant_bytes()
    return {
        "id": QWEN_TURBO_MODEL_ID,
        "label": "Qwen Image 2.1 Turbo · official",
        "bytes": download_bytes,
        "minimumFreeBytes": download_bytes + QWEN_TURBO_DISK_RESERVE,
        "generationDevices": [INTEL_GPU, CPU],
        "downloadIncludes": ["Text and vision encoders", "VAE"],
        "downloaded": int(job.get("downloaded") or 0),
        "installed": installed,
        "state": state,
        "error": job.get("error"),
        "phase": job.get("phase"),
        "logs": job["logs"],
        "runtimeReady": runtime_ready is True,
        "setupUnavailableReason": qwen_turbo_setup_unavailable(),
        "supportsReferenceImage": True,
    }


def model_library_snapshot() -> list[dict[str, Any]]:
    """Merge the regular catalog with Flux.3's separate runtime setup state."""
    if apple_silicon():
        item = next(model for model in MODEL_MANAGER.snapshot() if model["id"] == APPLE_IMAGE_ID)
        status = apple_image.status(MODELS_DIR, APPLE_IMAGE_ID, "AUTO")
        item.update(
            runtimeReady=status["runtimeReady"], supportsReferenceImage=False,
            setupUnavailableReason=None if status["selectedDevice"] else status["runtimeNote"],
            generationDevices=[APPLE_GPU], downloadIncludes=["Text encoder", "VAE"],
        )
        return [item]
    models = [item for item in MODEL_MANAGER.snapshot() if item["id"] != APPLE_IMAGE_ID]
    klein_installed = any(item["id"] in ("4b", "4b-lora") and item["installed"] for item in models)
    for item in models:
        model = item["id"]
        intel_only = model in flux2.LORA_MODEL_KEYS or model in INTEL_MEDIA_CATALOG
        item["generationDevices"] = [INTEL_GPU] if intel_only else [INTEL_GPU, NVIDIA_GPU, CPU]
        item["downloadIncludes"] = ["Text encoders" if tame_pony.is_model(model) else "Text encoder", "VAE"]
        if model == "kromoss-opd-dmd2":
            item["downloadIncludes"].append("Bundled LoRA")
        elif model == "sana-sprint":
            item["minimumFreeBytes"] = item["bytes"] + SANA_RUNTIME_RESERVE_BYTES
        if model in ("4b", "4b-lora"):
            item["uncensoredTextEncoder"] = KLEIN_TEXT_ENCODER_MANAGER.snapshot(klein_installed)
    flux3_item = next((item for item in models if item["id"] == flux3.MODEL_KEY), None)
    if flux3_item is not None:
        with FLUX3_SETUP_LOCK:
            setup = dict(FLUX3_SETUP_STATE)
        flux3_item["runtimeReady"] = flux3_klein_runtime.runtime_ready()
        flux3_item["supportsReferenceImage"] = False
        flux3_item["logs"] = list(setup.get("logs") or [])
        if setup["status"] == "installing":
            if not flux3_item["installed"] and flux3_item["state"] in ("downloading", "verifying"):
                phase = "Downloading and verifying FLUX.3 model files…"
            else:
                phase = setup.get("phase")
            flux3_item.update(state="installing", phase=phase, error=None)
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
    for item in models:
        if item["id"] in INTEL_MEDIA_CATALOG:
            item.update(
                platformSupported=intel_media_supported(),
                runtimeReady=intel_media_supported() and item["installed"],
                supportsReferenceImage=item["id"] == VIDEO_ID,
                setupUnavailableReason=None if intel_media_supported() else INTEL_MEDIA_PLATFORM_NOTE,
            )
    return models + [qwen_turbo_snapshot()] + custom_image_registry.MODEL_REGISTRY.snapshot()


def _run_flux3_setup(cancel_event: threading.Event) -> None:
    try:
        if cancel_event.is_set():
            raise InterruptedError("FLUX.3 setup was cancelled.")
        item = next(
            item for item in MODEL_MANAGER.snapshot() if item["id"] == flux3.MODEL_KEY
        )
        if not item["installed"]:
            if cancel_event.is_set():
                raise InterruptedError("FLUX.3 setup was cancelled.")
            if item["state"] not in ("downloading", "verifying"):
                MODEL_MANAGER.start(flux3.MODEL_KEY)
            while True:
                if cancel_event.is_set():
                    MODEL_MANAGER.cancel(flux3.MODEL_KEY)
                    raise InterruptedError("FLUX.3 setup was cancelled.")
                item = next(
                    item for item in MODEL_MANAGER.snapshot() if item["id"] == flux3.MODEL_KEY
                )
                if item["installed"]:
                    break
                if item["state"] == "failed":
                    raise RuntimeError(item.get("error") or "FLUX.3 model download failed.")
                if item["state"] == "paused":
                    raise InterruptedError("FLUX.3 model download was paused.")
                with FLUX3_SETUP_LOCK:
                    if FLUX3_SETUP_STATE["status"] == "installing":
                        FLUX3_SETUP_STATE["phase"] = "Downloading and verifying FLUX.3 model files…"
                cancel_event.wait(0.25)

        def progress(message: str) -> None:
            with FLUX3_SETUP_LOCK:
                FLUX3_SETUP_STATE["phase"] = message
                logs = FLUX3_SETUP_STATE.setdefault("logs", [])
                logs.append(message[:400])
                del logs[:-24]

        with FLUX3_SETUP_LOCK:
            FLUX3_SETUP_STATE["phase"] = "Preparing the isolated FLUX.3 runtime…"
        flux3_klein_runtime.ensure_runtime(progress, cancel_event)
        if cancel_event.is_set():
            raise InterruptedError("FLUX.3 setup was cancelled.")
        flux3.refresh_devices()
        with FLUX3_SETUP_LOCK:
            FLUX3_SETUP_STATE.update(status="idle", phase=None, error=None, logs=[])
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
            status="installing", phase="Downloading FLUX.3 model files…", error=None, logs=[]
        )
        event = FLUX3_SETUP_CANCEL
    threading.Thread(target=_run_flux3_setup, args=(event,), daemon=True).start()


def cancel_flux3_setup() -> None:
    with FLUX3_SETUP_LOCK:
        if FLUX3_SETUP_STATE["status"] == "installing":
            if FLUX3_SETUP_CANCEL is not None:
                FLUX3_SETUP_CANCEL.set()
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


def tts_setup_unavailable() -> str | None:
    if apple_silicon():
        return "Speech generation is unavailable in the Mac beta."
    if sys.platform == "linux":
        return "Qwen3-TTS setup is unavailable in the Linux beta."
    if sys.platform != "win32":
        return "Speech setup requires Fern on Windows x64."
    return None


@lru_cache(maxsize=5)
def tts_download_requirements(model: str) -> dict[str, Any]:
    try:
        return tts_model_download_details(model)
    except (OSError, KeyError, TypeError, ValueError, RuntimeError):
        return {}


def tts_snapshot() -> dict[str, Any]:
    with TTS_JOB_LOCK:
        job = dict(TTS_JOB)
        job["logs"] = list(TTS_JOB["logs"])
        job["diagnostics"] = list(TTS_JOB.get("diagnostics", []))
    environment_ready = tts_environment_ready()
    job["models"] = []
    for key, spec in TTS_MODELS.items():
        files_ready = tts_export_ready(TTS_MODEL_ROOT / f"{key}-OV", key)
        job["models"].append({
            "id": key, **spec, "installed": files_ready, "ready": files_ready and environment_ready,
            **tts_download_requirements(key),
        })
    job["environmentReady"] = environment_ready
    job["setupUnavailableReason"] = tts_setup_unavailable()
    return job


def chat_image_catalog() -> list[dict[str, Any]]:
    """List installed image models that can use the chat render path."""
    installed = {item["id"]: item for item in MODEL_MANAGER.snapshot() if item.get("installed")}
    if apple_silicon():
        item = installed.get(APPLE_IMAGE_ID)
        return [{"id": APPLE_IMAGE_ID, "label": item["label"]}] if item and apple_image.device_available() else []
    models = [
        {"id": key, "label": installed[key]["label"]} for key in IMAGE_MODEL_PRIORITY
        if key in installed and key != APPLE_IMAGE_ID and (key not in INTEL_MEDIA_CATALOG or intel_media_supported())
    ]
    for model in tame_pony.MODEL_KEYS:
        if model in installed:
            item = installed[model]
            models.append({"id": model, "label": item["label"], "defaultWidth": item["width"],
                           "defaultHeight": item["height"], "defaultSteps": item["steps"], "defaultGuidance": item["guidance"]})
    if qwen_turbo_model_ready():
        ready, devices = qwen_turbo_runtime_status()
        if ready and "GPU" in devices:
            models.append({"id": QWEN_TURBO_MODEL_ID, "label": "Qwen Image 2.1 Turbo · official",
                           "defaultWidth": 1024, "defaultHeight": 1024, "defaultSteps": 8, "defaultGuidance": 1})
    try:
        custom_models = custom_image_registry.MODEL_REGISTRY.snapshot()
    except ValueError:
        custom_models = []
    for item in custom_models:
        if not item or not item.get("installed"):
            continue
        family = custom_image_registry.FAMILIES[item["family"]]
        models.append({key: item[key] for key in ("id", "label", "defaultWidth", "defaultHeight", "defaultSteps", "defaultGuidance")} | {
            "minimumDimension": family["minimum"], "maximumDimension": family["maximum"], "dimensionMultiple": family["multiple"],
        })
    return models


def text_job_snapshot() -> dict[str, Any]:
    with TEXT_JOB_LOCK:
        return dict(TEXT_JOB)


def next_text_job_event(job_id: str, thread_id: str, revision: int, next_update: float) -> tuple[str, int, dict[str, Any] | None]:
    deadline = time.monotonic() + TEXT_JOB_STREAM_HEARTBEAT
    with TEXT_JOB_CHANGED:
        while TEXT_JOB.get("id") == job_id and TEXT_JOB.get("threadId") == thread_id:
            now = time.monotonic()
            changed = TEXT_JOB_REVISION != revision
            if TEXT_JOB["status"] != "running" or (changed and now >= next_update):
                return "job", TEXT_JOB_REVISION, dict(TEXT_JOB)
            if now >= deadline:
                return "heartbeat", revision, None
            wake_at = min(next_update, deadline) if changed else deadline
            TEXT_JOB_CHANGED.wait(wake_at - now)
    return "job", revision, None


def text_job_changed() -> None:
    # The caller holds TEXT_JOB_LOCK.
    global TEXT_JOB_REVISION
    TEXT_JOB_REVISION += 1
    TEXT_JOB_CHANGED.notify_all()


def finish_text_job(**fields: Any) -> None:
    TEXT_JOB.update(residentModel=TEXT_GENERATION_WORKER.resident_model(), **fields)
    text_job_changed()


def text_job_receipt(payload: dict[str, Any], job: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload.get("jobOnly") is True:
        return {"textJob": job if job is not None else text_job_snapshot()}
    runtime = text_runtime_snapshot()
    if job is not None:
        runtime["job"] = job
    return {"job": runtime}


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
    job = text_job_snapshot()
    specs = text_model_catalog()
    try:
        models = [
            {**model, "ownership": "managed" if managed_download_id(TEXT_MODEL_ROOT, model, specs) else "linked"}
            for model in TEXT_MODEL_REGISTRY.snapshot()
        ]
        registry_error = None
    except ValueError as error:
        models = []
        registry_error = str(error)
    with TEXT_MODEL_INSTALL_LOCK:
        model_install = dict(TEXT_MODEL_INSTALL)
    recommended = []
    for model_id, spec in specs.items():
        if apple_silicon() and spec["format"] != "gguf":
            continue
        folder = TEXT_MODEL_ROOT / spec["folder"]
        model_path, _ = text_model_files(folder, spec)
        entry = next((model for model in models if Path(model.get("path", "")).resolve() == model_path), None)
        installed = bool(entry and entry.get("installed"))
        repair_model_id = entry["id"] if entry and entry.get("ownership") == "managed" else None
        recommended.append({
            "id": model_id,
            "name": spec["name"],
            "repo": spec["repo"],
            **text_model_download_details(spec),
            "supportsTools": spec.get("supportsTools") is True,
            "installed": installed,
            "registeredModelId": entry["id"] if entry else None,
            "hasPartialDownload": (not installed or repair_model_id is not None) and has_partial_download(TEXT_MODEL_ROOT, spec),
            "repairModelId": repair_model_id,
            "format": spec["format"],
        })
    gguf_available = gguf_runtime_supported()
    return {
        "job": job,
        "supportsJobPolling": True,
        "supportsJobEvents": True,
        "supportsPendingStop": True,
        "supportsModelLoad": True,
        "supportsModelUnload": True,
        "models": models,
        "recommendedModels": recommended,
        "imageToolModels": chat_image_catalog(),
        "defaultModelId": "gemma-4-e4b-gguf" if apple_silicon() else DEFAULT_TEXT_MODEL_ID,
        "modelInstall": model_install,
        "residentModel": TEXT_GENERATION_WORKER.resident_model(),
        "registryError": registry_error,
        "runtimeAvailable": runtime_available,
        "runtimeError": runtime_error,
        "ggufAvailable": gguf_available,
        "ggufUnavailableReason": None if gguf_available else RUNTIME_PLATFORM_ERROR,
        "devices": ["AUTO", "GPU", "CPU"],
    }


def append_text_event(job_id: str, *, phase: str | None = None, token: str | None = None, reasoning: str | None = None) -> None:
    with TEXT_JOB_LOCK:
        if (TEXT_JOB.get("id") != job_id or TEXT_JOB.get("status") != "running"
                or TEXT_JOB.get("phase") == "Stopping generation…"):
            return
        updates = {}
        if phase is not None and phase[:500] != TEXT_JOB.get("phase"):
            updates["phase"] = phase[:500]
        if token:
            current = str(TEXT_JOB.get("partialText") or "")
            if len(current) < 100_000:
                updates["partialText"] = current + token[:100_000 - len(current)]
        if reasoning:
            current = str(TEXT_JOB.get("partialReasoning") or "")
            if len(current) < 100_000:
                updates["partialReasoning"] = current + reasoning[:100_000 - len(current)]
        if updates:
            TEXT_JOB.update(updates)
            text_job_changed()


def text_job_running() -> bool:
    with TEXT_JOB_LOCK:
        return TEXT_JOB.get("status") == "running"


def qwen_turbo_setup_running() -> bool:
    with QWEN_JOB_LOCK:
        return QWEN_JOB.get("status") in ("setting_up", "downloading")


def record_pending_text_stop(request_id: str, thread_id: str) -> bool:
    with TEXT_ADMISSION_LOCK, TEXT_JOB_LOCK:
        if TEXT_JOB.get("id") == request_id and TEXT_JOB.get("threadId") == thread_id:
            return False
        now = time.monotonic()
        for key, expires in list(TEXT_PENDING_STOPS.items()):
            if expires <= now:
                del TEXT_PENDING_STOPS[key]
        key = (request_id, thread_id)
        if key not in TEXT_PENDING_STOPS and len(TEXT_PENDING_STOPS) >= TEXT_PENDING_STOP_LIMIT:
            raise ValueError("Could not cancel this pending request. Try stopping it when the model starts.")
        TEXT_PENDING_STOPS[key] = now + TEXT_PENDING_STOP_SECONDS
        return True


def start_text_job(payload: dict[str, Any], request_id: Any, admit_before: Any = None) -> dict[str, Any] | None:
    global TEXT_CANCEL_EVENT
    model_load = bool(payload.get("modelLoad"))
    with TTS_JOB_LOCK:
        audio_busy = TTS_JOB.get("status") in ("running", "setting_up", "stopping")
    with FLUX_JOB_LOCK:
        image_busy = FLUX_JOB.get("status") == "running"
    if audio_busy or image_busy or VIDEO_JOBS.running() or qwen_turbo_setup_running() or text_model_install_running():
        raise ValueError("Finish the active media job or model setup before starting a text response.")
    job_id = request_id or str(uuid.uuid4())
    if not isinstance(job_id, str) or len(job_id) > 100:
        raise ValueError("Invalid text request ID.")
    with TEXT_ADMISSION_LOCK, TEXT_JOB_LOCK:
        if TEXT_PENDING_STOPS.get((job_id, payload["threadId"]), 0) > time.monotonic():
            return {
                "id": job_id, "threadId": payload["threadId"], "modelId": payload["modelId"],
                "status": "stopped", "phase": "Model load cancelled." if model_load else "Generation stopped.",
                "partialText": "", "startedAt": None,
                "finishedAt": time.time(), "result": None, "error": None,
                **({"modelLoad": True} if model_load else {}),
            }
        if TEXT_JOB.get("id") == job_id and TEXT_JOB.get("threadId") == payload["threadId"]:
            return None
        # The renderer already stopped waiting. Do not start a response from a delayed POST.
        if admit_before is not None and (type(admit_before) is not int or admit_before <= time.time() * 1000):
            raise ValueError("The request timed out before the model could start. Try again.")
        if TEXT_JOB.get("status") == "running":
            raise ValueError("A text response is already running.")
        cancel_event = threading.Event()
        TEXT_CANCEL_EVENT = cancel_event
        TEXT_JOB.update(
            id=job_id, threadId=payload["threadId"], modelId=payload["modelId"],
            status="running", phase="Preparing model…" if model_load else "Queued…", partialText="", partialReasoning="",
            startedAt=time.time(), finishedAt=None, result=None, image=payload.get("inspectionImage"),
            images=[],
            inspection=payload.get("inspectionImage") is not None,
            modelLoad=model_load,
            error=None, errorCode=None, failureDiagnostics=None, residentModel=None, unavailableDocumentIds=None,
        )
        text_job_changed()
    threading.Thread(target=run_text_generation, args=(payload, job_id, cancel_event), daemon=True).start()
    return None


def validate_text_sampling(options: Any) -> dict[str, Any]:
    if options is None:
        return {}
    if not isinstance(options, dict) or set(options) - {"topK", "minP", "repeatPenalty", "stopSequences"}:
        raise ValueError("Choose valid text sampling options.")
    if "topK" in options and (type(options["topK"]) is not int or not 0 <= options["topK"] <= 2_147_483_647):
        raise ValueError("Top K must be a non-negative whole number.")
    if "minP" in options and (type(options["minP"]) not in (int, float) or not 0 <= options["minP"] < 1):
        raise ValueError("Min P must be at least zero and less than one.")
    if "repeatPenalty" in options and (
        type(options["repeatPenalty"]) not in (int, float) or not 0 < options["repeatPenalty"] <= 3.402823466e38
    ):
        raise ValueError("Repetition penalty must be a positive number.")
    if "stopSequences" in options:
        values = options["stopSequences"]
        if (not isinstance(values, list) or len(values) > 32
            or any(not isinstance(value, str) or not value.strip() or len(value) > 256 for value in values)):
            raise ValueError("Use up to 32 stop sequences of 256 characters each.")
    return options


def record_text_image_context(result: dict[str, Any], request: dict[str, Any]) -> None:
    context = result.get("context")
    if not isinstance(context, dict) or not isinstance(context.get("imageNames"), list):
        return
    used = set(context["imageNames"])
    available = {Path(turn["imagePath"]).name for turn in request["messages"] if turn.get("imagePath")}
    unavailable = set(request.get("unavailableImageNames", ())) - available - used
    if omitted := available - used:
        context["omittedImages"] = len(omitted)
    if unavailable:
        context["unavailableImages"] = len(unavailable)
    selected = request.get("selectedImageName")
    if selected in used:
        context["reusedImageName"] = selected


def run_text_generation(payload: dict[str, Any], job_id: str, cancel_event: threading.Event) -> None:
    model_load = bool(payload.get("modelLoad"))
    start_stage = "loading-model" if model_load else "preparing-conversation"
    diagnostics = {"stage": start_stage, "requestedDevice": payload.get("device")}

    def release_apple_image_worker() -> None:
        if GENERATION_WORKER.process is None:
            return
        diagnostics["stage"] = "releasing-image-runtime"
        append_text_event(job_id, phase="Releasing the image model…")
        GENERATION_WORKER.close(cancel_event=cancel_event)
        diagnostics["stage"] = start_stage

    try:
        image_model = payload.get("imageModel")
        inspection_image = payload.get("inspectionImage")
        if image_model not in INTEL_MEDIA_CATALOG and not inspection_image:
            INTEL_MEDIA.close()
        if apple_silicon():
            release_apple_image_worker()
        elif not image_model and not inspection_image:
            GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        CUSTOM_IMAGE_GENERATION_WORKER.close()
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
            raise ValueError("Add this text model again; its files are no longer available.")
        device = payload["device"]
        diagnostics["runtime"] = "gguf" if model.get("format") == "gguf" else "openvino"
        if not model_load:
            append_text_event(job_id, phase="Preparing conversation…")
        passages = []
        if attachments := payload.get("documentIds"):
            diagnostics["stage"] = "finding-documents"
            append_text_event(job_id, phase="Finding document passages…")
            passages = retrieve_passages(DATA_DIR / "chat-documents", attachments, payload["messages"], payload["contextSize"])
        if cancel_event.is_set():
            raise InterruptedError()

        def generate(request: dict[str, Any]) -> dict[str, Any]:
            diagnostics["stage"] = start_stage

            def append_output(token: str, *, reasoning: bool = False) -> None:
                if token:
                    diagnostics["stage"] = "generating-reply"
                if reasoning:
                    append_text_event(job_id, reasoning=token)
                else:
                    append_text_event(job_id, token=token)

            return TEXT_GENERATION_WORKER.generate(
                model_path=model["path"],
                device=device,
                command=[
                    str(Path(sys.executable)), "-u", str(SCRIPTS / "text_generation_worker.py"), model["path"], device,
                    *([model["projectorPath"]] if model.get("projectorPath") else []),
                ],
                request={**request, "op": "load" if model_load else "generate", "ggufArchitecture": model.get("architecture")},
                cwd=ROOT,
                env={
                    **os.environ,
                    "PYTHONUNBUFFERED": "1",
                    "PYTHONUTF8": "1",
                    "PYTHONIOENCODING": "utf-8",
                    "FERN_GGUF_RUNTIME_ROOT": str(DATA_DIR / "gguf-runtime"),
                },
                on_token=append_output,
                on_phase=lambda phase: append_text_event(job_id, phase=phase),
                on_reasoning=lambda token: append_output(token, reasoning=True),
                on_diagnostic=diagnostics.update,
                cancel_event=cancel_event,
            )

        request = {key: value for key, value in payload.items() if key not in ("selectedImageName", "unavailableImageNames")}
        if image_model:
            request["tools"] = [IMAGE_TOOL]
        if passages:
            request["documentPassages"] = passages
        result = generate(request)
        if model_load:
            with TEXT_JOB_LOCK:
                if cancel_event.is_set():
                    raise InterruptedError()
                resident = TEXT_GENERATION_WORKER.resident_model()
                if not resident or resident.get("modelId") != payload["modelId"]:
                    raise RuntimeError("The model engine exited before it was ready.")
                finish_text_job(status="complete", phase="Model ready.", finishedAt=time.time())
            return
        diagnostics["stage"] = "checking-reply"
        calls = result.pop("toolCalls", [])
        if inspection_image and result.get("text", "").strip():
            result["visionChecked"] = True
        elif inspection_image:
            raise RuntimeError("The model returned an empty image inspection. Try again.")
        if calls and image_model:
            if result.get("device") != "GPU":
                raise RuntimeError("Select GPU in Preferences to use the image tool in chat.")
            prompt = image_tool_prompt(calls)
            diagnostics["stage"] = "generating-image"
            append_text_event(job_id, phase="Generating an image…")

            def show_image(artifact: dict[str, Any]) -> None:
                with TEXT_JOB_LOCK:
                    if TEXT_JOB.get("id") == job_id:
                        saved = TEXT_JOB.get("images", [])
                        if not any(item["name"] == artifact["name"] for item in saved):
                            TEXT_JOB.update(images=[*saved, artifact], image=saved[0] if saved else artifact)
                            text_job_changed()

            image = generate_chat_image(image_model, prompt, payload["threadId"], job_id, cancel_event, payload.get("imageSettings"),
                                        message_image=payload["messages"][-1].get("imagePath"), on_image=show_image)
            show_image(image)
            if image_model == APPLE_IMAGE_ID:
                release_apple_image_worker()
            append_text_event(job_id, phase="Checking the generated image…")
            prior = result.get("text", "").strip()
            tool_reply = json.dumps({
                "status": "created", "prompt": prompt, "width": image["width"], "height": image["height"],
                "instruction": "The image is displayed in the chat. Briefly confirm it is ready.",
            })
            continuation = generate({
                **request, "toolChoice": "none", "mode": "instant",
                "documentPassages": [],
                "maxNewTokens": min(request["maxNewTokens"], 96),
                "messages": [
                    *request["messages"],
                    {"role": "assistant", "content": prior, "tool_calls": calls},
                    {"role": "tool", "name": "generate_image", "tool_call_id": calls[0]["id"], "content": tool_reply},
                    {
                        "role": "user",
                        "content": "Inspect the attached generated image. Briefly tell me what is actually visible and mention any obvious mismatch with my request.",
                        "imagePath": str(OUTPUTS / image["name"]),
                    },
                ],
            })
            diagnostics["stage"] = "checking-reply"
            if not continuation.get("text", "").strip():
                raise RuntimeError("The model returned an empty image inspection. Try again.")
            result["text"] = "\n\n".join(
                part for part in (prior, continuation["text"].strip()) if part
            )
            result["reasoning"] = "\n\n".join(
                part for part in (result.get("reasoning"), continuation.get("reasoning")) if part
            )
            for field in ("inputTokens", "outputTokens", "generationSeconds"):
                result[field] += continuation[field]
            result["tokensPerSecond"] = result["outputTokens"] / max(result["generationSeconds"], 0.001)
            # The displayed reply now combines separate model calls and an image job.
            result.pop("runtimeTiming", None)
            result["visionChecked"] = True
            review_context = continuation.get("context")
            if review_context is not None:
                earlier_names = (result.get("context") or {}).get("imageNames", [])
                if "imageNames" in review_context:
                    # The reply used both calls, including the image created during review.
                    names = list(dict.fromkeys([*earlier_names, *review_context["imageNames"]]))
                    review_context = {**review_context, "imageNames": names, "images": len(names)}
                result["context"] = review_context
            result["finishReason"] = continuation.get("finishReason")
        record_text_image_context(result, payload)
        if cancel_event.is_set():
            raise InterruptedError()
        with TEXT_JOB_LOCK:
            if cancel_event.is_set():
                raise InterruptedError()
            if TEXT_JOB.get("id") == job_id:
                result.update(modelId=model["id"], modelName=model["name"], device=result.get("device", device),
                              seed=payload["seed"], temperature=payload["temperature"],
                              topP=payload["topP"], maxNewTokens=result.get("maxNewTokens", payload["maxNewTokens"]),
                              sampling=payload.get("sampling"))
                finish_text_job(
                    status="complete", finishedAt=time.time(), phase="Response complete.",
                    partialText=result.get("text", ""), partialReasoning=result.get("reasoning", ""),
                    result=result, error=None,
                )
    except Exception as error:
        stopped = isinstance(error, InterruptedError) or cancel_event.is_set()
        if stopped and model_load:
            try:
                TEXT_GENERATION_WORKER.unload(payload["modelId"])
            except (OSError, subprocess.SubprocessError) as cleanup_error:
                error = cleanup_error
                stopped = False
        stopped_phase = "Model load cancelled." if model_load else "Generation stopped."
        failed_phase = "Model load failed." if model_load else "Generation failed."
        with TEXT_JOB_LOCK:
            if TEXT_JOB.get("id") == job_id:
                if not model_load:
                    stopped = stopped or cancel_event.is_set()
                finish_text_job(status="stopped" if stopped else "failed", finishedAt=time.time(),
                                phase=stopped_phase if stopped else failed_phase,
                                error=None if stopped else (str(error) or type(error).__name__)[-1000:],
                                errorCode=error.code if not stopped and isinstance(error, TextWorkerError) else None,
                                unavailableDocumentIds=error.document_ids if not stopped and isinstance(error, ChatDocumentsUnavailable) else None,
                                failureDiagnostics=None if stopped else diagnostics)


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
        INTEL_MEDIA.close()
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
    unavailable = qwen_turbo_setup_unavailable()
    if unavailable:
        raise ValueError(unavailable)
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
        require_tts_install_space(model, TTS_MODEL_ROOT)
        # The separate speech environment is installed while no generation is
        # active; also release idle workers so setup has predictable headroom.
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TEXT_GENERATION_WORKER.close()
        INTEL_MEDIA.close()
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
        if not tts_export_ready(TTS_MODEL_ROOT / f"{model}-OV", model):
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
        INTEL_MEDIA.close()
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
    if apple_silicon():
        return apple_image.status(MODELS_DIR, APPLE_IMAGE_ID if model == "auto" else model, device)
    if model == APPLE_IMAGE_ID:
        return apple_image.status(MODELS_DIR, model, device)
    if model in INTEL_MEDIA_CATALOG:
        return INTEL_MEDIA.status(model, device)
    if custom_image.is_model(model):
        try:
            return custom_image.model_status(device, model)
        except ValueError as error:
            return {"selectedModel": model, "runtimeReady": False, "runtimeNote": str(error), "requestedDevice": device, "adapters": []}
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
                "OpenVINO runtime is unavailable. Repair it in Models." if model_ready else
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
                    for choice in (*flux2.KLEIN_MODEL_KEYS, *tame_pony.MODEL_KEYS):
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
    if model not in ("auto", *flux2.KLEIN_MODEL_KEYS): model = "9b"
    requested_model = model
    resolved_model = flux2.resolve_model(model, device)
    with MODEL_CHECK_LOCK:
        if not MODEL_CHECK_STARTED:
            MODEL_CHECK_STARTED = True
            def check():
                results = {}
                for choice in (*flux2.KLEIN_MODEL_KEYS, *tame_pony.MODEL_KEYS):
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


def output_asset(path: Path, info: os.stat_result) -> dict[str, Any]:
    url = f"/outputs/{urllib.parse.quote(path.name)}"
    record = {"name": path.name, "url": url, "mtime": info.st_mtime}
    if path.suffix.lower() == ".png":
        record["thumbnailUrl"] = f"{url}?thumbnail=1&v={gallery_store.thumbnail_version(info)}"
    return record


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
                record = output_asset(path, path.stat())
            except FileNotFoundError:
                continue  # An image can be moved to Recycle Bin during a listing.
            records.append(gallery_store.enrich_image_record(record, metadata))
        records.sort(key=lambda record: record["mtime"], reverse=True)
        IMAGE_LIST_CACHE.update(key=key, checkedAt=now, records=records)
        return list(records)


def image_record(path: Path, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    record = output_asset(path, path.stat())
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
            if source.width * source.height > 16_000_000:
                raise ValueError("Reference image is too large. Keep it at 16 megapixels or less.")
            return ImageOps.exif_transpose(source).convert("RGB")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Could not read the reference image.") from exc


@contextmanager
def publish_chat_attachment(storage_revision: int, kind: str) -> Iterator[None]:
    with JOB_ADMISSION_LOCK:
        if storage_revision != CHAT_ATTACHMENT_STORAGE_REVISION:
            raise ValueError(f"Local data was cleared. Attach the {kind} again.")
        yield


def store_chat_image(value: Any, storage_revision: int) -> str:
    image = decode_flux_reference_image(value)
    if image is None:
        raise ValueError("Choose an image to attach.")
    image.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    content = buffer.getvalue()
    filename = f"chat-image-{hashlib.sha256(content).hexdigest()[:32]}.png"
    directory = DATA_DIR / "references"
    path = directory / filename
    # Image decoding and encoding can take time. Serialize only publication so
    # Stop and other panes do not wait for that work.
    with publish_chat_attachment(storage_revision, "image"):
        if not path.exists():
            directory.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".upload")
            try:
                temporary.write_bytes(content)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
    return filename


def is_chat_image_name(filename: Any) -> bool:
    return isinstance(filename, str) and re.fullmatch(r"chat-image-[a-f0-9]{32}\.png", filename) is not None


def chat_image_path(filename: Any) -> str:
    if not is_chat_image_name(filename):
        raise ValueError("The attached chat image is invalid.")
    directory = (DATA_DIR / "references").resolve()
    path = (directory / filename).resolve()
    if path.parent != directory or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("The attached chat image is missing or invalid. Attach it again.")
    return str(path)


def validate_flux_payload(payload: dict[str, Any]) -> dict[str, Any]:
    model = payload.get("model", "9b")
    if not isinstance(model, str):
        raise ValueError("Choose an installed Fern image model.")
    if apple_silicon():
        if model == "auto":
            model = APPLE_IMAGE_ID
        if model != APPLE_IMAGE_ID:
            raise ValueError("Choose Klein 4B · MLX to create images on this Mac.")
    elif model == APPLE_IMAGE_ID:
        raise ValueError("Klein 4B · MLX requires Apple Silicon.")
    custom_model = custom_image.is_model(model)
    if model not in ("auto", QWEN_TURBO_MODEL_ID, flux3.MODEL_KEY) and not custom_model: model_spec(model)
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
        APPLE_GPU,
        "CPU",
    }:
        raise ValueError("Device must be Auto-select, Intel GPU, NVIDIA GPU, or CPU.")
    device = normalize_device(raw_device)
    if device == APPLE_GPU and model != APPLE_IMAGE_ID:
        raise ValueError("Choose an image model that supports Apple GPU.")
    if custom_model and device in ("NVIDIA_GPU",):
        raise ValueError("Custom OpenVINO GenAI image models support Intel GPU or CPU. Select Auto, Intel GPU, or CPU.")
    custom_spec = custom_image.model_spec(model) if custom_model else None
    if model == QWEN_TURBO_MODEL_ID:
        if device not in ("AUTO", "INTEL_GPU", "CPU"):
            raise ValueError("Official Qwen Turbo uses the OpenVINO Intel GPU or an explicitly selected CPU.")
        if not (qwen_turbo_runtime_ready() and qwen_turbo_model_ready()):
            raise ValueError("Install the official Qwen Turbo OpenVINO INT8 model from Models before generating.")
    intel_spec = INTEL_MEDIA_CATALOG.get(model)
    fixed_spec = APPLE_IMAGE_SPEC if model == APPLE_IMAGE_ID else intel_spec
    # The Vulkan scheduler accepts a signed step count and adds a final sigma.
    adjustable_step_limit = fixed_spec.get("maximumSteps") if fixed_spec else None
    if model == APPLE_IMAGE_ID and device not in ("AUTO", APPLE_GPU):
        raise ValueError("Select Available GPU in Preferences to use Klein 4B on this Mac.")
    if intel_spec:
        if intel_spec["category"] != "image":
            raise ValueError("Open Video to generate with Wan.")
        if device not in ("AUTO", "INTEL_GPU"):
            raise ValueError("Choose Intel GPU or Auto to generate with this model.")
    backend = flux2
    width = int(payload.get("width", fixed_spec["defaultWidth"] if fixed_spec else backend.DEFAULT_WIDTH))
    height = int(payload.get("height", fixed_spec["defaultHeight"] if fixed_spec else backend.DEFAULT_HEIGHT))
    raw_steps = payload.get("steps", fixed_spec["defaultSteps"] if fixed_spec else backend.DEFAULT_STEPS)
    if adjustable_step_limit and (isinstance(raw_steps, bool) or isinstance(raw_steps, float) and not raw_steps.is_integer()):
        raise ValueError("Steps must be a positive whole number.")
    steps = int(raw_steps)
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
    reference_sources = payload.get("reference_images")
    if reference_sources is None:
        reference_sources = [payload["reference_image"]] if payload.get("reference_image") else []
    if not isinstance(reference_sources, list) or len(reference_sources) > 4:
        raise ValueError("Attach up to 4 reference images.")
    if any(not isinstance(source, str) or not source for source in reference_sources):
        raise ValueError("Each reference image must be a PNG, JPEG, or WebP upload.")
    if len(reference_sources) > 1 and model not in ("auto", *flux2.KLEIN_MODEL_KEYS):
        raise ValueError("Multiple reference images are supported by FLUX.2 Klein 4B and 9B.")
    reference_images = [decode_flux_reference_image(source) for source in reference_sources]
    reference_image = reference_images[0] if reference_images else None
    if fixed_spec and reference_image is not None:
        raise ValueError("This model generates images from a text prompt.")
    fixed_dimensions = fixed_spec.get("dimensions") if fixed_spec else None
    if fixed_dimensions and (width != height or width not in fixed_dimensions):
        sizes = " or ".join(f"{size}×{size}" for size in fixed_dimensions)
        raise ValueError(f"Choose {sizes} for {fixed_spec['label']}.")
    if fixed_spec:
        if adjustable_step_limit is None:
            steps = fixed_spec["defaultSteps"]
        guidance = fixed_spec["defaultGuidance"]
        if batch_size != 1:
            raise ValueError("Generate one image at a time with this model.")
        if not 0 <= seed <= 2_147_483_647:
            raise ValueError("Seed must be an integer between 0 and 2,147,483,647.")
    loras = payload.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 4:
        raise ValueError("Choose up to four LoRAs.")
    if loras and model not in (*flux2.LORA_MODEL_KEYS, Z_IMAGE_ID):
        raise ValueError("Choose Klein 4B LoRA, Klein 9B LoRA, or Z-Image Turbo to use adapters.")
    checked_loras = []
    lora_paths = set()
    for lora in loras:
        if not isinstance(lora, dict) or not isinstance(lora.get("path"), str):
            raise ValueError("Choose a local LoRA file.")
        path = Path(lora["path"]).expanduser().resolve(strict=True)
        if not path.is_file() or path.suffix.lower() != ".safetensors":
            raise ValueError("Choose a local .safetensors LoRA file.")
        if str(path).casefold() in lora_paths:
            raise ValueError("Each LoRA can only be added once.")
        lora_paths.add(str(path).casefold())
        strength = float(lora.get("strength", 1.0))
        if not math.isfinite(strength) or not -4 <= strength <= 4:
            raise ValueError("LoRA strength must be between -4 and 4.")
        enabled = lora.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("LoRA enabled must be true or false.")
        checked_loras.append({"path": str(path), "strength": strength, "enabled": enabled})
    if model == flux3.MODEL_KEY and reference_image is not None:
        raise ValueError("This FLUX.3 Klein OpenVINO quant currently supports text-to-image only.")
    is_tame_pony = tame_pony.is_model(model)
    if (is_tame_pony or custom_model) and reference_image is not None:
        raise ValueError("This model currently supports text-to-image only.")

    custom_family = custom_image_registry.FAMILIES[custom_spec["family"]] if custom_spec else None
    dimension_multiple = custom_family["multiple"] if custom_family else 8 if is_tame_pony else 32 if model == QWEN_TURBO_MODEL_ID else 16
    minimum = custom_family["minimum"] if custom_family else 512 if is_tame_pony else 256
    model_maximum = custom_family["maximum"] if custom_family else 1536 if is_tame_pony else 1920
    if fixed_spec:
        dimension_multiple = fixed_spec.get("dimensionMultiple", dimension_multiple)
        minimum = fixed_spec.get("minimumDimension", minimum)
        model_maximum = fixed_spec.get("maximumDimension", model_maximum)
    if width < minimum or width > model_maximum or width % dimension_multiple != 0:
        raise ValueError(f"Width must be {minimum} to {model_maximum} and divisible by {dimension_multiple}.")
    if height < minimum or height > model_maximum or height % dimension_multiple != 0:
        raise ValueError(f"Height must be {minimum} to {model_maximum} and divisible by {dimension_multiple}.")
    if model == flux3.MODEL_KEY and (width != flux3.VALIDATED_WIDTH or height != flux3.VALIDATED_HEIGHT):
        raise ValueError("This FLUX.3 quant is currently validated at 1024×1024 only.")
    if not 1 <= steps <= (adjustable_step_limit or 50):
        raise ValueError("Steps are outside the supported range.")
    if guidance < 0 or guidance > (20 if custom_model else 10):
        raise ValueError("Guidance is outside the supported range.")
    if model in flux2.LORA_MODEL_KEYS and guidance != 1.0:
        raise ValueError("Klein LoRA models use guidance 1.0.")
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
        "reference_images": reference_images,
        "model": model,
        "reference_source": payload.get("reference_image") if reference_image is not None else None,
        "reference_sources": reference_sources,
        "loras": checked_loras,
    }


def run_flux_generation(
    job_id: str,
    payload: dict[str, Any],
    cancel_event: threading.Event,
    *,
    on_chat_progress: Callable[[str], None] | None = None,
    on_chat_artifact: Callable[[dict[str, Any]], None] | None = None,
    chat_job_id: str | None = None,
) -> dict[str, Any] | None:
    log_event = on_chat_progress or append_flux_log
    payload["use_uncensored_text_encoder"] = bool(
        payload.get("model") in ("4b", "4b-lora")
        and KLEIN_TEXT_ENCODER_MANAGER.snapshot(
            any(item["id"] in ("4b", "4b-lora") and item["installed"] for item in MODEL_MANAGER.snapshot())
        )["enabled"]
    )

    def log_generation(message: str) -> None:
        display_message = message
        for prefix in ("FERN_QWEN_PROGRESS:", "FERN_TTS_PROGRESS:", flux3.PROGRESS_PREFIX):
            if display_message.startswith(prefix):
                display_message = display_message[len(prefix):].strip()
                break
        log_event(display_message)
        if on_chat_progress is not None:
            if cancel_event.is_set():
                raise FluxGenerationCancelled("Generation stopped by user.")
            return
        if message.startswith(("Loading Flux", "Loading Qwen", "Loading Tame Pony", "Loading the OpenVINO", "Loading ")):
            mark_runtime(status="loading", message="Loading model for generation…", error=None)
        elif message.startswith(("Seed:", "Step ", "Qwen denoising step", "Tame Pony SDXL ")):
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
    intel_model = payload["model"] in INTEL_MEDIA_CATALOG
    apple_model = payload["model"] == APPLE_IMAGE_ID
    try:
        if not intel_model:
            INTEL_MEDIA.close()
        if on_chat_progress is None:
            TEXT_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        if payload.get("model") != QWEN_TURBO_MODEL_ID:
            QWEN_GENERATION_WORKER.close()
        if not tame_pony.is_model(payload.get("model", "")) and not custom_image.is_model(payload.get("model", "")):
            TAME_PONY_GENERATION_WORKER.close()
        if not custom_image.is_model(payload.get("model", "")):
            CUSTOM_IMAGE_GENERATION_WORKER.close()
        if on_chat_progress is None and not apple_model and payload.get("model") not in flux2.LORA_MODEL_KEYS:
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
        reference_urls = []
        reference_sources = payload.get("reference_sources", [payload["reference_source"]] if payload.get("reference_source") else [])
        for reference_source in reference_sources:
            header, encoded = reference_source.split(",", 1)
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
            reference_urls.append(f"/references/{urllib.parse.quote(reference_name)}")
        last_record = None
        for index in range(payload["batch_size"]):
            if cancel_event.is_set():
                raise FluxGenerationCancelled("Generation stopped by user.")
            seed = payload["seed"] + index
            log_event(f"Batch image {index + 1}/{payload['batch_size']} | seed {seed}")
            metadata = {
                "threadId": payload.get("thread_id"),
                "prompt": payload["prompt"],
                "textEncoder": "uncensored-qwen3-4b-int4-ov" if payload.get("use_uncensored_text_encoder") and payload.get("model") in ("4b", "4b-lora") else "default",
                "loras": [{"name": Path(item["path"]).name, "strength": item["strength"]} for item in payload.get("loras", []) if item["enabled"]],
                "seed": seed,
                "width": payload["width"],
                "height": payload["height"],
                "steps": payload["steps"],
                "guidance": payload["guidance"],
                "device": resolve_qwen_turbo_device(payload["device"]) if payload["model"] == QWEN_TURBO_MODEL_ID else payload["device"],
                "modelPath": str(
                    INTEL_MEDIA.folder(payload["model"])
                    if intel_model
                    else MODEL_MANAGER.folder(APPLE_IMAGE_ID)
                    if apple_model
                    else QWEN_TURBO_MODEL_ROOT
                    if payload["model"] == QWEN_TURBO_MODEL_ID
                    else flux3.MODEL_DIR
                    if payload["model"] == flux3.MODEL_KEY
                    else custom_image.model_spec(payload["model"])["path"]
                    if custom_image.is_model(payload["model"])
                    else tame_pony.model_dir_for(payload["model"])
                    if tame_pony.is_model(payload["model"])
                    else flux2.model_dir_for(payload["device"], payload.get("model", "9b"))
                ),
                "model": payload.get("model", "9b"),
                "modelLabel": (
                    custom_image.model_spec(payload["model"])["label"]
                    if custom_image.is_model(payload["model"])
                    else "Qwen Image 2.1 Turbo · official"
                    if payload["model"] == QWEN_TURBO_MODEL_ID
                    else model_spec(payload["model"])["label"]
                ),
                "modelFamily": custom_image.model_spec(payload["model"])["familyLabel"] if custom_image.is_model(payload["model"]) else None,
                "modelRevision": (
                    "84d3f71fff32fc6c4740b89f5556657d0c65af27"
                    if payload["model"] == QWEN_TURBO_MODEL_ID
                    else "local-custom"
                    if custom_image.is_model(payload["model"])
                    else payload.get("modelRevision", model_spec(payload.get("model", "9b"))["revision"])
                ),
                "createdAt": time.time(),
            }
            if intel_model:
                output_path, generation_time = INTEL_MEDIA.generate_image(
                    {**payload, "seed": seed}, stage / f"{payload['model']}-{job_id}-{index + 1}.png",
                    cancel_event, log_generation,
                )
            elif payload["model"] == QWEN_TURBO_MODEL_ID:
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
            elif custom_image.is_model(payload["model"]):
                output_name = f"custom-image-{job_id}-{index + 1}.png"
                output_path, generation_time = CUSTOM_IMAGE_GENERATION_WORKER.generate(
                    cancel_event=cancel_event,
                    model_id=payload["model"], prompt=payload["prompt"],
                    width=payload["width"], height=payload["height"], steps=payload["steps"],
                    guidance=payload["guidance"], seed=seed, device=payload["device"],
                    output_dir=stage, output_name=output_name, log=log_generation,
                )
                if output_path.resolve().parent != stage.resolve() or output_path.name != output_name:
                    raise RuntimeError("Custom image model returned an image outside its generation workspace.")
                if not output_path.is_file() or output_path.stat().st_size <= 0:
                    raise RuntimeError("Custom image model did not create a valid output image.")
                if not math.isfinite(generation_time) or generation_time < 0:
                    raise RuntimeError("Custom image model returned an invalid generation duration.")
                with Image.open(output_path) as output_image:
                    output_image.verify()
                with Image.open(output_path) as output_image:
                    if output_image.size != (payload["width"], payload["height"]):
                        raise RuntimeError("Custom image output dimensions do not match the request.")
            else:
                output_path, generation_time = GENERATION_WORKER.generate(
                    cancel_event=cancel_event,
                    model=payload.get("model", "9b"),
                    use_uncensored_text_encoder=payload.get("use_uncensored_text_encoder", False),
                    loras=payload.get("loras", []),
                    prompt=payload["prompt"],
                    width=payload["width"],
                    height=payload["height"],
                    steps=payload["steps"],
                    guidance=payload["guidance"],
                    seed=seed,
                    device=payload["device"],
                    reference_image=payload["reference_image"],
                    reference_images=payload.get("reference_images"),
                    compile_cache=CACHE_DIR / "openvino" / f"chat-{payload['model']}" if on_chat_progress is not None else None,
                    output_dir=stage,
                    log=log_generation,
                )
                if apple_model:
                    if output_path.resolve().parent != stage.resolve():
                        raise RuntimeError("Klein MLX returned an image outside its generation workspace.")
                    with Image.open(output_path) as output_image:
                        if output_image.format != "PNG" or output_image.size != (payload["width"], payload["height"]):
                            raise RuntimeError("Klein MLX output does not match the requested PNG dimensions.")
                        output_image.verify()
            if cancel_event.is_set():
                raise FluxGenerationCancelled("Generation stopped by user.")
            destination = OUTPUTS / output_path.name
            if output_path != destination:
                output_path.replace(destination)
            output_path = destination
            metadata["referenceUsed"] = payload["reference_image"] is not None
            if on_chat_progress is not None:
                metadata["source"] = "chat"
                metadata["chatJobId"] = chat_job_id
            if reference_urls:
                metadata["referenceUrl"] = reference_urls[0]
                metadata["referenceUrls"] = reference_urls
            metadata["generationTime"] = round(generation_time, 1)
            last_record = image_record(output_path, metadata)
            if on_chat_artifact is not None:
                on_chat_artifact(last_record)
        if on_chat_progress is not None:
            return last_record
        append_flux_log(f"Batch complete | {payload['batch_size']} image(s).")
        mark_flux_job(
            status="complete",
            finishedAt=time.time(),
            output=last_record,
            error=None,
        )
        if payload["model"] == QWEN_TURBO_MODEL_ID:
            mark_runtime(status="ready", device=payload["device"], message="Qwen Turbo is ready for another image.", error=None)
        elif intel_model:
            mark_runtime(status="ready", device=payload["device"], message=f"{model_spec(payload['model'])['label']} is ready for another image.", error=None)
        elif payload["model"] == flux3.MODEL_KEY:
            mark_runtime(status="ready", device=payload["device"], message="FLUX.3 Klein is ready for another image.", error=None)
        elif tame_pony.is_model(payload["model"]):
            mark_runtime(status="ready", device=payload["device"], message=f"{tame_pony.display_name(payload['model'])} is ready for another image.", error=None)
        elif custom_image.is_model(payload["model"]):
            mark_runtime(status="ready", device=payload["device"], message=f"{custom_image.model_spec(payload['model'])['label']} is ready for another image.", error=None)
        cleanup_cache_when_model_idle()
    except FluxGenerationCancelled:
        if intel_model:
            INTEL_MEDIA.close()
        if on_chat_progress is not None:
            raise
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        CUSTOM_IMAGE_GENERATION_WORKER.close()
        mark_runtime(status="idle", message="Generation stopped. Model will reload on the next generation.", error=None)
        append_flux_log("Generation stopped by user.")
        mark_flux_job(status="cancelled", finishedAt=time.time(), output=None, error=None)
    except Exception as exc:
        if intel_model:
            INTEL_MEDIA.close()
        if on_chat_progress is not None:
            raise
        if cancel_event.is_set():
            QWEN_GENERATION_WORKER.close()
            FLUX3_GENERATION_WORKER.close()
            TAME_PONY_GENERATION_WORKER.close()
            CUSTOM_IMAGE_GENERATION_WORKER.close()
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
        if custom_image.is_model(payload.get("model", "")):
            CUSTOM_IMAGE_GENERATION_WORKER.close()
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
    return None


def chat_image_owner(thread_id: str, source_thread_id: Any) -> str:
    if source_thread_id is None:
        return thread_id
    if not isinstance(source_thread_id, str) or not source_thread_id.startswith("text-thread-") or len(source_thread_id) > 100:
        raise ValueError("The saved image's conversation is invalid.")
    return source_thread_id


def prepare_image_inspection(payload: dict[str, Any]) -> dict[str, Any]:
    thread_id = payload.get("threadId")
    filename = payload.get("image")
    model_id = payload.get("modelId")
    device = payload.get("device", "AUTO")
    if not isinstance(thread_id, str) or not thread_id.startswith("text-thread-") or len(thread_id) > 100:
        raise ValueError("The text conversation is invalid.")
    if not isinstance(filename, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+\.png", filename):
        raise ValueError("Choose a saved image from this conversation.")
    if device not in ("AUTO", "GPU", "CPU"):
        raise ValueError("Choose Auto, Intel GPU, or CPU.")
    model = next((item for item in TEXT_MODEL_REGISTRY.snapshot() if item["id"] == model_id), None)
    if not model or not model.get("installed") or not model.get("supportsVision"):
        raise ValueError("Choose an installed vision model before checking this image.")
    gguf = model.get("format") == "gguf"
    if gguf and not gguf_runtime_supported():
        raise ValueError(RUNTIME_PLATFORM_ERROR)
    context_size = validate_context_size(payload.get("contextSize"), model.get("maxContextSize")) if gguf else DEFAULT_CONTEXT_SIZE
    load_options = validate_gguf_load_options(payload.get("loadOptions"), context_size)
    if load_options and not gguf:
        raise ValueError("These load settings require a GGUF model.")
    metadata = gallery_store.get_image_metadata(filename)
    if not metadata or metadata.get("threadId") != chat_image_owner(thread_id, payload.get("imageThreadId")) or metadata.get("source") != "chat":
        raise ValueError("Choose a saved image from this conversation.")
    path = (OUTPUTS / filename).resolve()
    if path.parent != OUTPUTS.resolve() or not path.is_file():
        raise ValueError("The image file is missing. Restore it before retrying the check.")
    artifact = {key: metadata[key] for key in ("name", "width", "height", "modelLabel", "prompt")}
    prompt = "Inspect the attached image. Briefly describe what is actually visible."
    if artifact["prompt"]:
        prompt += f" The image was requested as follows: {artifact['prompt']}. Mention any obvious mismatch."
    return {
        "modelId": model_id, "threadId": thread_id, "device": device, "inspectionImage": artifact,
        "requireGpuVision": metadata.get("model") in INTEL_MEDIA_CATALOG or metadata.get("model") == APPLE_IMAGE_ID,
        "messages": [{"role": "user", "content": prompt, "imagePath": str(path)}],
        "mode": "instant", "toolChoice": "none", "contextSize": context_size, "loadOptions": load_options,
        "systemPrompt": "", "temperature": 0.2, "topP": 0.9, "maxNewTokens": 96, "seed": 0,
    }


def generate_chat_image(
    model: str, prompt: str, thread_id: str,
    job_id: str, cancel_event: threading.Event, settings: dict[str, Any] | None = None,
    *, message_image: str | None = None, on_image: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    device = APPLE_GPU if model == APPLE_IMAGE_ID else "INTEL_GPU"
    extra_model = tame_pony.is_model(model) or custom_image.is_model(model) or model == QWEN_TURBO_MODEL_ID
    status = model_snapshot(device, model)
    while status.get("checking"):
        if cancel_event.wait(0.15):
            raise InterruptedError("Image generation cancelled.")
        status = model_snapshot(device, model)
    if not status["runtimeReady"] or status["selectedDevice"] != device:
        raise RuntimeError(str(status["runtimeNote"]))
    overrides = dict(settings or {})
    suffix = overrides.pop("promptSuffix", "").strip()
    if suffix:
        separator = " " if prompt.endswith((".", "!", "?", ",")) else ", "
        prompt = f"{prompt}{separator}{suffix}"
    references = [chat_image_path(item) for item in overrides.pop("referenceImages", [])]
    if overrides.pop("useMessageImage", False) and message_image:
        references.insert(0, message_image)
    image_request = validate_flux_payload({
        "model": model, "prompt": prompt,
        "width": status.get("defaultWidth", 1024) if extra_model else CHAT_IMAGE_SIZE,
        "height": status.get("defaultHeight", 1024) if extra_model else CHAT_IMAGE_SIZE,
        "device": device, "steps": status.get("defaultSteps", 8) if extra_model else INTEL_MEDIA_CATALOG.get(model, {}).get("defaultSteps", 4),
        "guidance": status.get("defaultGuidance", 1.0) if extra_model else 1.0, "thread_id": thread_id,
        "seed": uuid.uuid4().int % 2_147_483_647,
        "batch_size": overrides.pop("batchSize", 1),
        "reference_images": [
            "data:image/png;base64," + base64.b64encode(Path(source).read_bytes()).decode("ascii")
            for source in dict.fromkeys(references)
        ],
        **overrides,
    })
    image_request["modelRevision"] = status["modelRevision"]
    first_image = None

    def publish_artifact(record: dict[str, Any]) -> None:
        nonlocal first_image
        artifact = chat_image_artifact(record)
        if first_image is None:
            first_image = artifact
        if on_image is not None:
            on_image(artifact)

    record = run_flux_generation(
        uuid.uuid4().hex, image_request, cancel_event,
        on_chat_progress=lambda message: append_text_event(job_id, phase=f"Generating image · {message}"),
        on_chat_artifact=publish_artifact,
        chat_job_id=job_id,
    )
    if record is None:
        raise RuntimeError("The image tool did not return a saved image.")
    return first_image if first_image is not None else chat_image_artifact(record)


def chat_image_artifact(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record[key] for key in ("name", "width", "height", "modelLabel", "prompt")}


def recover_chat_images(thread_id: str, job_id: str) -> list[dict[str, Any]]:
    """Match saved renders to a pending chat request after a backend restart."""
    images = []
    for filename, metadata in gallery_store.metadata_snapshot().items():
        if (
            metadata.get("source") != "chat"
            or metadata.get("threadId") != thread_id
            or metadata.get("chatJobId") != job_id
        ):
            continue
        path = (OUTPUTS / filename).resolve()
        if path.parent == OUTPUTS.resolve() and path.suffix.lower() == ".png" and path.is_file():
            try:
                images.append((path.stat().st_mtime_ns, chat_image_artifact(metadata)))
            except FileNotFoundError:
                continue
    return [image for _, image in sorted(images, key=lambda item: item[0])]


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Fern-Document-Name")

    def send_json(self, status: int, data: dict[str, Any], *, no_store: bool = False) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def stream_text_job(self, job_id: str, thread_id: str) -> None:
        # Bound the time spent writing to a stalled or abandoned renderer.
        self.connection.settimeout(4)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        revision, next_update = -1, 0.0
        previous = None
        while True:
            event, revision, job = next_text_job_event(job_id, thread_id, revision, next_update)
            terminal = event == "job" and (job is None or job["status"] != "running")
            if event == "heartbeat":
                frame = {"heartbeat": True}
            elif not terminal and previous is not None and job is not None:
                frame = {"append": {
                    "phase": job.get("phase"),
                    "text": job.get("partialText", "")[len(previous.get("partialText", "")):],
                    "reasoning": job.get("partialReasoning", "")[len(previous.get("partialReasoning", "")):],
                }}
                if job.get("images") is not previous.get("images"):
                    frame["append"].update(image=job.get("image"), images=job.get("images", []))
            else:
                frame = {"job": job}
            body = json.dumps(frame, separators=(",", ":")).encode("utf-8")
            self.wfile.write(b"data: " + body + b"\n\n")
            self.wfile.flush()
            if terminal:
                return
            if job is not None:
                previous = job
                next_update = time.monotonic() + TEXT_JOB_STREAM_INTERVAL

    def read_json_body(self, *, too_large: str = "Request is too large. Attach up to 4 images smaller than 10 MB each.") -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 60 * 1024 * 1024:
            raise ValueError(too_large)
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

        if parsed.path == "/api/text/job":
            self.send_json(200, text_job_snapshot())
            return

        if parsed.path == "/api/text/documents/source":
            query = urllib.parse.parse_qs(parsed.query)
            try:
                source = read_document_source(
                    DATA_DIR / "chat-documents", query.get("documentId", [""])[0],
                    int(query.get("passageIndex", [""])[0]), int(query.get("quotedCharacters", [""])[0]),
                    query.get("fingerprint", [""])[0],
                )
            except ValueError:
                self.send_json(400, {"error": "Choose a valid document source."}, no_store=True)
            else:
                if source is None:
                    self.send_json(404, {"error": "The local passage is unavailable."}, no_store=True)
                else:
                    self.send_json(200, source, no_store=True)
            return

        if parsed.path == "/api/text/job/events":
            query = urllib.parse.parse_qs(parsed.query)
            job_id = query.get("jobId", [""])[0]
            thread_id = query.get("threadId", [""])[0]
            if not 1 <= len(job_id) <= 100 or not thread_id.startswith("text-thread-") or len(thread_id) > 100:
                self.send_json(400, {"error": "The chat request could not be identified."})
                return
            if not TEXT_JOB_STREAMS.acquire(blocking=False):
                self.send_json(429, {"error": "Too many active chat streams."})
                return
            try:
                self.stream_text_job(job_id, thread_id)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            finally:
                TEXT_JOB_STREAMS.release()
            return

        if parsed.path == "/api/text/recover-image":
            query = urllib.parse.parse_qs(parsed.query)
            thread_id = query.get("threadId", [""])[0]
            job_id = query.get("jobId", [""])[0]
            if not thread_id.startswith("text-thread-") or len(thread_id) > 100 or not job_id or len(job_id) > 100:
                self.send_json(400, {"error": "The pending chat request could not be identified."})
            else:
                images = recover_chat_images(thread_id, job_id)
                self.send_json(200, {"image": images[0] if images else None, "images": images})
            return

        if parsed.path == "/api/video/status":
            self.send_json(200, {
                "job": VIDEO_JOBS.snapshot(),
                "model": INTEL_MEDIA.status(VIDEO_ID, "AUTO"),
                "clips": VIDEO_JOBS.history() if "job=1" not in parsed.query.split("&") else None,
            })
            return

        if parsed.path == "/api/tts/status":
            self.send_json(200, tts_snapshot())
            return

        if parsed.path == "/api/models":
            self.send_json(200, {"models": model_library_snapshot(), "customImageDownload": CUSTOM_IMAGE_DOWNLOAD.snapshot()})
            return

        if parsed.path == "/api/loras/download":
            self.send_json(200, LORA_DOWNLOAD.snapshot())
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
                    "installedModels": [{key: item[key] for key in ("id", "label", "family", "familyLabel", "defaultSteps", "defaultGuidance", "defaultWidth", "defaultHeight", "dimensions", "installed") if key in item} for item in model_library_snapshot() if item.get("category") != "video" and item.get("platformSupported", True) and (item["installed"] or item["id"].startswith("custom-"))]
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

            try:
                info = path.stat()
            except OSError:
                self.send_error(404)
                return

            if parsed.path.startswith("/outputs/") and path.suffix.lower() == ".png" and parsed.query:
                query = urllib.parse.parse_qs(parsed.query)
                if query.get("thumbnail") == ["1"]:
                    version = gallery_store.thumbnail_version(info)
                    try:
                        data = gallery_store.image_thumbnail(path, version, CACHE_DIR / "image-thumbnails")
                    except (OSError, ValueError, Image.DecompressionBombError):
                        self.send_error(404)
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "image/webp")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "private, max-age=86400, immutable" if query.get("v") == [version] else "no-store")
                    self.send_cors_headers()
                    self.end_headers()
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return

            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            size = info.st_size
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
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/text/stop":
            self.stop_text()
            return
        if path == "/api/text/models/install/pause":
            self.pause_text_model_download()
            return
        if path == "/api/text/images":
            storage_revision = CHAT_ATTACHMENT_STORAGE_REVISION
            try:
                with CHAT_IMAGE_UPLOAD_SLOTS:
                    image = store_chat_image(self.read_json_body().get("image"), storage_revision)
                self.send_json(201, {"image": image})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
        if path == "/api/text/documents":
            storage_revision = CHAT_ATTACHMENT_STORAGE_REVISION
            try:
                with CHAT_DOCUMENT_UPLOAD_LOCK:
                    if self.headers.get_content_type() == "application/octet-stream":
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= MAX_DOCUMENT_BYTES:
                            raise ValueError("Choose a non-empty document up to 20 MB.")
                        name = urllib.parse.unquote(self.headers.get("X-Fern-Document-Name", ""), errors="strict")
                        content = self.rfile.read(length)
                        if len(content) != length:
                            raise ValueError("The document upload is incomplete or invalid. Attach it again.")
                    else:
                        payload = self.read_json_body(too_large="Choose a document up to 20 MB.")
                        name, content = payload.get("name"), payload.get("content")
                    document = store_document(
                        DATA_DIR / "chat-documents", name, content,
                        storage_guard=publish_chat_attachment(storage_revision, "document"),
                    )
                self.send_json(201, {"document": document})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
        with JOB_ADMISSION_LOCK:
            self.handle_post()

    def pause_text_model_download(self) -> None:
        try:
            job_id = self.read_json_body().get("jobId")
            if not isinstance(job_id, str) or not 1 <= len(job_id) <= 100:
                raise ValueError("Choose the text model download to pause.")
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        with TEXT_MODEL_INSTALL_LOCK:
            if TEXT_MODEL_INSTALL["id"] == job_id and TEXT_MODEL_INSTALL["status"] == "downloading" and TEXT_MODEL_DOWNLOAD_PAUSE:
                TEXT_MODEL_DOWNLOAD_PAUSE.set()
                phase = "Pausing repair…" if TEXT_MODEL_INSTALL.get("operation") == "repair" else "Pausing download…"
                TEXT_MODEL_INSTALL.update(status="pausing", phase=phase)
            snapshot = dict(TEXT_MODEL_INSTALL)
        self.send_json(202, {"modelInstall": snapshot})

    def stop_text(self) -> None:
        try:
            payload = self.read_json_body()
            request_id = payload.get("requestId")
            thread_id = payload.get("threadId")
            if thread_id is not None:
                if (not isinstance(thread_id, str) or not thread_id.startswith("text-thread-") or len(thread_id) > 100
                        or not isinstance(request_id, str) or not 1 <= len(request_id) <= 100):
                    raise ValueError("Invalid pending text request.")
                # Pending cancellation must be able to answer while another POST is still being admitted.
                if record_pending_text_stop(request_id, thread_id):
                    self.send_json(202, {"cancelledBeforeStart": True})
                    return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return

        with JOB_ADMISSION_LOCK, TEXT_ADMISSION_LOCK:
            cancel_event = None
            with TEXT_JOB_LOCK:
                running = (TEXT_JOB.get("status") == "running"
                           and (request_id is None or request_id == TEXT_JOB.get("id"))
                           and (thread_id is None or thread_id == TEXT_JOB.get("threadId")))
                if running:
                    TEXT_JOB["phase"] = "Stopping generation…"
                    text_job_changed()
                    cancel_event = TEXT_CANCEL_EVENT
                    if cancel_event is not None:
                        cancel_event.set()
            if running:
                if cancel_event is not None:
                    TEXT_GENERATION_WORKER.request_stop(cancel_event)
                INTEL_MEDIA.interrupt()
            receipt = text_job_receipt(payload)
        self.send_json(202, receipt)

    def start_video(self, payload: dict[str, Any]) -> None:
        if (
            VIDEO_JOBS.running() or flux_job_snapshot()["status"] == "running" or text_job_running()
            or tts_job_running() or qwen_turbo_setup_running() or text_model_install_running()
        ):
            self.send_json(409, {"error": "Finish or stop the current job before generating video."})
            return
        raw_device = str(payload.get("device", "AUTO")).upper()
        if raw_device not in ("AUTO", "GPU", "INTEL_GPU", "CPU", "NVIDIA_GPU"):
            raise ValueError("Choose Auto or Intel GPU to generate video.")
        device = normalize_device(raw_device)
        status = INTEL_MEDIA.status(VIDEO_ID, device)
        if not status["runtimeReady"]:
            raise ValueError(status["runtimeNote"])
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2000:
            raise ValueError("Enter a motion prompt of up to 2,000 characters.")
        seed = payload.get("seed", 42)
        if type(seed) is not int or not 0 <= seed <= 2_147_483_647:
            raise ValueError("Seed must be an integer between 0 and 2,147,483,647.")
        reference = decode_flux_reference_image(payload.get("referenceImage"))
        if reference is None:
            raise ValueError("Choose an image to use as the clip’s first frame.")
        spec = INTEL_MEDIA_CATALOG[VIDEO_ID]
        frame = ImageOps.fit(reference, (spec["defaultWidth"], spec["defaultHeight"]), Image.Resampling.LANCZOS)

        def release_models():
            for worker in (
                GENERATION_WORKER, TAME_PONY_GENERATION_WORKER, CUSTOM_IMAGE_GENERATION_WORKER,
                TTS_GENERATION_WORKER, QWEN_GENERATION_WORKER, FLUX3_GENERATION_WORKER, TEXT_GENERATION_WORKER,
            ):
                worker.close()
            flux2.release_pipeline()
        self.send_json(202, {"job": VIDEO_JOBS.start({
            "prompt": prompt.strip(), "seed": seed, "reference": frame,
        }, release_models)})

    def handle_post(self) -> None:
        global CHAT_ATTACHMENT_STORAGE_REVISION, FLUX_CANCEL_EVENT, TTS_CANCEL_EVENT
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path in ("/api/video/generate", "/api/video/stop", "/api/video/remove"):
            try:
                if parsed.path.endswith("/stop"):
                    self.send_json(202, {"job": VIDEO_JOBS.stop()})
                elif parsed.path.endswith("/remove"):
                    VIDEO_JOBS.remove(self.read_json_body().get("id"))
                    self.send_json(200, {"job": VIDEO_JOBS.snapshot(), "clips": VIDEO_JOBS.history()})
                else:
                    self.start_video(self.read_json_body())
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            return

        if VIDEO_JOBS.running() and parsed.path in (
            "/api/flux2/generate", "/api/text/generate", "/api/text/inspect-image",
            "/api/text/models/install", "/api/text/models/load", "/api/tts/setup", "/api/tts/generate",
            "/api/storage/cleanup-cache", "/api/storage/clear-local-data",
        ):
            self.send_json(409, {"error": "Finish or stop the current video generation first."})
            return

        if parsed.path == "/api/text/models/install":
            global TEXT_MODEL_DOWNLOAD_PAUSE
            try:
                payload = self.read_json_body()
                model_id = payload.get("modelId")
                repair = payload.get("repair", False)
                catalog = text_model_catalog()
                if not isinstance(model_id, str) or model_id not in catalog:
                    raise ValueError("Choose a recommended text model.")
                if not isinstance(repair, bool):
                    raise ValueError("Choose whether to install or repair the model.")
                if apple_silicon() and catalog[model_id]["format"] != "gguf":
                    raise ValueError("Choose a GGUF model on this Mac.")
                if catalog[model_id]["format"] == "gguf" and not gguf_runtime_supported():
                    raise ValueError(RUNTIME_PLATFORM_ERROR)
                with TTS_JOB_LOCK:
                    audio_busy = TTS_JOB.get("status") in ("running", "setting_up", "stopping")
                with FLUX_JOB_LOCK:
                    image_busy = FLUX_JOB.get("status") == "running"
                if audio_busy or image_busy or text_job_running() or tts_job_running() or qwen_turbo_setup_running() or text_model_install_running():
                    raise ValueError("Finish the active generation or model setup before installing a text model.")
                if repair and not any(managed_download_id(TEXT_MODEL_ROOT, model, {model_id: catalog[model_id]})
                                      for model in TEXT_MODEL_REGISTRY.snapshot()):
                    raise ValueError("Fern can repair only its own verified downloads. Import a replacement for linked files.")
                job_id = str(uuid.uuid4())
                pause = threading.Event()
                with TEXT_MODEL_INSTALL_LOCK:
                    TEXT_MODEL_DOWNLOAD_PAUSE = pause
                    TEXT_MODEL_INSTALL.update(id=job_id, status="downloading", error=None, modelId=model_id,
                                              phase="Checking downloaded files…" if repair else "Preparing download…",
                                              operation="repair" if repair else "install")
                threading.Thread(target=run_text_model_install, args=(model_id, job_id, pause, repair), daemon=True).start()
                self.send_json(202, text_runtime_snapshot())
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/text/models/unload":
            try:
                model_id = self.read_json_body().get("modelId")
                if not isinstance(model_id, str) or not 1 <= len(model_id) <= 64:
                    raise ValueError("Choose a text model to unload.")
                if text_job_running():
                    self.send_json(409, {"error": "Finish or stop the current chat response before unloading the model."})
                    return
                TEXT_GENERATION_WORKER.unload(model_id)
                self.send_json(200, {"residentModel": TEXT_GENERATION_WORKER.resident_model()})
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except (OSError, subprocess.SubprocessError) as error:
                self.send_json(500, {"error": f"Could not unload the text model. {error}"})
            return

        if parsed.path in ("/api/text/models/import", "/api/text/models/remove"):
            try:
                payload = self.read_json_body()
                if text_job_running() or text_model_install_running():
                    raise ValueError("Wait for the current text response or model installation before changing models.")
                if parsed.path.endswith("/import"):
                    paths = payload.get("ggufPaths")
                    if paths is None:
                        if apple_silicon():
                            raise ValueError("Choose a GGUF model on this Mac.")
                        folder = payload.get("path")
                        if not isinstance(folder, str) or not folder.strip() or len(folder) > 4096:
                            raise ValueError("Choose a local model folder or GGUF model.")
                        model = TEXT_MODEL_REGISTRY.add(folder)
                    else:
                        if not gguf_runtime_supported():
                            raise ValueError(RUNTIME_PLATFORM_ERROR)
                        if not isinstance(paths, list) or not 1 <= len(paths) <= 2 or any(
                            not isinstance(path, str) or not path.strip() or len(path) > 4096 for path in paths
                        ):
                            raise ValueError("Select one GGUF model and its optional vision projector.")
                        models, projectors = [], []
                        for path in paths:
                            metadata = read_gguf_metadata(Path(path).expanduser().resolve(strict=True))
                            (projectors if is_projector(metadata) else models).append(path)
                        if len(models) != 1 or len(projectors) > 1:
                            raise ValueError("Select one language model and at most one GGUF projector.")
                        model = TEXT_MODEL_REGISTRY.add(models[0], projectors[0] if projectors else None)
                else:
                    model_id = payload.get("modelId")
                    if not isinstance(model_id, str) or len(model_id) > 64:
                        raise ValueError("Choose a model to remove from the library.")
                    action = payload.get("action", "unlink")
                    if action not in ("unlink", "remove-download"):
                        raise ValueError("Choose how to remove this model.")
                    registered = TEXT_MODEL_REGISTRY.snapshot()
                    model = next((item for item in registered if item["id"] == model_id), None)
                    if model is None:
                        raise ValueError("That text model is no longer in the library.")
                    TEXT_GENERATION_WORKER.close()
                    if action == "remove-download":
                        remove_text_model_download(TEXT_MODEL_ROOT, model, registered, TEXT_MODEL_REGISTRY.remove)
                    else:
                        TEXT_MODEL_REGISTRY.remove(model_id)
                snapshot = text_runtime_snapshot()
                self.send_json(200, {"model": model, "models": snapshot["models"],
                                     "recommendedModels": snapshot["recommendedModels"]})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/text/inspect-image":
            try:
                payload = self.read_json_body()
                job = start_text_job(prepare_image_inspection(payload), payload.get("requestId"), payload.get("admitBefore"))
                self.send_json(202, text_job_receipt(payload, job))
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path in ("/api/text/generate", "/api/text/models/load"):
            try:
                model_load = parsed.path.endswith("/load")
                payload = self.read_json_body(too_large="The conversation exceeds Fern's 60 MB request limit.")
                model_id = payload.get("modelId")
                if not isinstance(model_id, str) or len(model_id) > 64:
                    raise ValueError("Select a text model first.")
                model = next((item for item in TEXT_MODEL_REGISTRY.snapshot() if item["id"] == model_id), None)
                if model is None or not model.get("installed"):
                    raise ValueError("Add the selected text model again.")
                if model.get("format") == "gguf" and not gguf_runtime_supported():
                    raise ValueError(RUNTIME_PLATFORM_ERROR)
                mode = "instant" if model_load else payload.get("mode", "instant")
                if mode not in ("instant", "reasoning"):
                    raise ValueError("Choose Instant or Reasoning mode.")
                if mode == "reasoning" and not model.get("supportsReasoning"):
                    raise ValueError("The selected model has no reasoning mode.")
                thread_id = payload.get("threadId")
                if not isinstance(thread_id, str) or not thread_id.startswith("text-thread-") or len(thread_id) > 100:
                    raise ValueError("The text conversation is invalid. Start a new text thread and retry.")
                messages = payload.get("messages")
                gguf = model.get("format") == "gguf"
                if apple_silicon() and not gguf:
                    raise ValueError("Choose a GGUF model on this Mac.")
                if model_load:
                    context_size = validate_context_size(payload.get("contextSize"), model.get("maxContextSize"))
                    load_options = validate_gguf_load_options(payload.get("loadOptions"), context_size)
                    if load_options and not gguf:
                        raise ValueError("These load settings require a GGUF model.")
                    device = payload.get("device", "AUTO")
                    if device not in ("AUTO", "GPU", "CPU"):
                        raise ValueError("Choose Auto, Intel GPU, or CPU.")
                    job = start_text_job({
                        "modelLoad": True, "threadId": thread_id, "modelId": model_id, "device": device,
                        "contextSize": context_size, "loadOptions": load_options,
                    }, payload.get("requestId"), payload.get("admitBefore"))
                    self.send_json(202, text_job_receipt(payload, job))
                    return
                if not isinstance(messages, list) or not messages:
                    raise ValueError("The conversation must contain at least one message.")
                if not gguf and len(messages) > 100:
                    raise ValueError("This OpenVINO chat supports up to 100 messages per conversation.")
                safe_messages = []
                total_chars = 0
                generated_images = None
                unavailable_images: set[str] = set()
                selected_image_name = None
                require_gpu_vision = False
                for message in messages:
                    if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
                        raise ValueError("The conversation contains an unsupported message.")
                    content = message.get("content")
                    if not isinstance(content, str) or not content.strip():
                        raise ValueError("Each message must contain text.")
                    if not gguf and len(content) > 20_000:
                        raise ValueError("OpenVINO messages must contain 20,000 characters or fewer.")
                    total_chars += len(content)
                    turn = {"role": message["role"], "content": content}
                    image_owner = chat_image_owner(thread_id, message.get("imageThreadId"))
                    if message["role"] == "assistant" and isinstance(message.get("generatedImage"), str):
                        if generated_images is None:
                            generated_images = gallery_store.metadata_snapshot()
                        saved = generated_images.get(message["generatedImage"], {})
                        if saved.get("threadId") == image_owner and saved.get("source") == "chat":
                            description = str(saved.get("prompt", ""))[:2000]
                            turn["content"] += "\n\nImage generated in this turn: " + description
                            total_chars += len(description)
                            filename = message["generatedImage"]
                            path = (OUTPUTS / filename).resolve()
                            if model.get("supportsVision") and path.parent == OUTPUTS.resolve():
                                if path.is_file():
                                    turn["imagePath"] = str(path)
                                    require_gpu_vision |= saved.get("model") in INTEL_MEDIA_CATALOG or saved.get("model") == APPLE_IMAGE_ID
                                elif re.fullmatch(r"[a-zA-Z0-9_-]+\.png", filename):
                                    unavailable_images.add(filename)
                    if message.get("image") is not None:
                        if message["role"] != "user" or not model.get("supportsVision"):
                            raise ValueError("Choose a vision-capable GGUF model to use chat images.")
                        try:
                            turn["imagePath"] = chat_image_path(message["image"])
                        except ValueError:
                            if message is messages[-1]:
                                raise
                            if is_chat_image_name(message["image"]):
                                unavailable_images.add(message["image"])
                    included_name = message.get("includedImage")
                    if included_name is not None:
                        if message["role"] != "user" or not model.get("supportsVision") or "imagePath" in turn:
                            raise ValueError("Choose a vision model and one image for this message.")
                        if not isinstance(included_name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+\.png", included_name):
                            raise ValueError("Choose a saved image from this conversation.")
                        if generated_images is None:
                            generated_images = gallery_store.metadata_snapshot()
                        saved = generated_images.get(included_name, {})
                        path = (OUTPUTS / included_name).resolve()
                        if saved.get("threadId") == image_owner and saved.get("source") == "chat" and path.parent == OUTPUTS.resolve() and path.is_file():
                            turn["imagePath"] = str(path)
                            if message is messages[-1]:
                                selected_image_name = included_name
                        elif message is messages[-1]:
                            raise ValueError("The selected image is unavailable. Remove it from the draft or restore the file.")
                        else:
                            unavailable_images.add(included_name)
                    safe_messages.append(turn)
                if safe_messages[-1]["role"] != "user" or any(item["role"] != ("user" if index % 2 == 0 else "assistant") for index, item in enumerate(safe_messages)):
                    raise ValueError("The last conversation message must be from you.")
                if not gguf and total_chars > 80_000:
                    raise ValueError("This conversation is too long. Start a new text thread to continue.")
                system_prompt = payload.get("systemPrompt", "")
                if not isinstance(system_prompt, str) or len(system_prompt) > 10_000:
                    raise ValueError("The system prompt must be 10,000 characters or fewer.")
                device = payload.get("device", "AUTO")
                if device not in ("AUTO", "GPU", "CPU"):
                    raise ValueError("Choose Auto, Intel GPU, or CPU.")
                image_model = payload.get("imageModel")
                image_settings = chat_image_overrides(payload.get("imageSettings"))
                if image_model is None and image_settings:
                    raise ValueError("Select an image generation model before setting image options.")
                if image_model is not None:
                    if not (model.get("supportsTools") and model.get("supportsVision")):
                        raise ValueError("Select a vision-capable chat model with tool calling and its vision projector.")
                    if device == "CPU":
                        raise ValueError("Select GPU in Preferences to use the image tool in chat.")
                    if not isinstance(image_model, str) or not any(item["id"] == image_model for item in chat_image_catalog()):
                        raise ValueError("Select an installed image model in Chat settings.")
                context_size = validate_context_size(payload.get("contextSize"), model.get("maxContextSize"))
                load_options = validate_gguf_load_options(payload.get("loadOptions"), context_size)
                if load_options and not gguf:
                    raise ValueError("These load settings require a GGUF model.")
                maximum_output = context_size if gguf else 8192
                max_new_tokens = payload.get("maxNewTokens", 512)
                if type(max_new_tokens) is not int or not 1 <= max_new_tokens <= maximum_output:
                    raise ValueError(f"Maximum output length must be between 1 and {maximum_output:,} tokens.")
                temperature = payload.get("temperature", 0.7)
                top_p = payload.get("topP", 0.9)
                sampling = validate_text_sampling(payload.get("sampling"))
                if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2:
                    raise ValueError("Temperature must be between 0 and 2.")
                if isinstance(top_p, bool) or not isinstance(top_p, (int, float)) or not 0.01 <= top_p <= 1:
                    raise ValueError("Top P must be between 0.01 and 1.")
                seed = payload.get("seed", 0)
                if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
                    raise ValueError("Seed must be an integer between 0 and 2,147,483,647.")
                generation = {
                    "modelId": model_id, "device": device,
                    "messages": safe_messages, "systemPrompt": system_prompt.strip(),
                    "temperature": float(temperature), "topP": float(top_p),
                    "sampling": sampling,
                    "maxNewTokens": max_new_tokens,
                    "seed": seed,
                    "mode": mode,
                    "threadId": thread_id, "imageModel": image_model, "contextSize": context_size,
                    "imageSettings": image_settings,
                    "loadOptions": load_options,
                    "documentIds": document_ids(payload.get("documentIds")),
                    "requireGpuVision": require_gpu_vision or image_model in INTEL_MEDIA_CATALOG or image_model == APPLE_IMAGE_ID,
                    **({"selectedImageName": selected_image_name} if selected_image_name else {}),
                    **({"unavailableImageNames": sorted(unavailable_images)} if unavailable_images else {}),
                }
                job = start_text_job(generation, payload.get("requestId"), payload.get("admitBefore"))
                self.send_json(202, text_job_receipt(payload, job))
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
                unavailable = tts_setup_unavailable() if parsed.path.endswith("setup") else None
                if unavailable:
                    raise ValueError(unavailable)
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
            if FLUX_JOB.get("model") in INTEL_MEDIA_CATALOG:
                INTEL_MEDIA.interrupt()
            elif FLUX_JOB.get("model") == QWEN_TURBO_MODEL_ID:
                QWEN_GENERATION_WORKER.interrupt()
            elif FLUX_JOB.get("model") == flux3.MODEL_KEY:
                FLUX3_GENERATION_WORKER.interrupt()
            elif tame_pony.is_model(FLUX_JOB.get("model", "")):
                TAME_PONY_GENERATION_WORKER.interrupt()
            elif custom_image.is_model(FLUX_JOB.get("model", "")):
                CUSTOM_IMAGE_GENERATION_WORKER.interrupt()
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
                CUSTOM_IMAGE_GENERATION_WORKER.close()
                QWEN_GENERATION_WORKER.close()
                FLUX3_GENERATION_WORKER.close()
                TEXT_GENERATION_WORKER.close()
                INTEL_MEDIA.close()
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
                    TEXT_JOB.update(id=None, threadId=None, status="idle", partialText="", partialReasoning="", result=None, image=None, error=None,
                                    errorCode=None, failureDiagnostics=None, residentModel=None, modelLoad=False, unavailableDocumentIds=None)
                    text_job_changed()
                INTEL_MEDIA.close()
                flux2.release_pipeline()
                cache_result = storage_manager.cleanup_cache(ROOT, CACHE_DIR, force=True)
                VIDEO_JOBS.clear()
                output_files, output_bytes = storage_manager.clear_directory(OUTPUTS)
                CHAT_ATTACHMENT_STORAGE_REVISION += 1
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

        if parsed.path == "/api/models/custom/add":
            try:
                if flux_job_snapshot()["status"] == "running":
                    raise ValueError("Stop image generation before adding a model.")
                body = self.read_json_body()
                path = body.get("path")
                family = body.get("family")
                if not isinstance(path, str) or not isinstance(family, str):
                    raise ValueError("Choose an export folder and supported model family.")
                custom_image_registry.MODEL_REGISTRY.add(path, family)
                self.send_json(200, {"models": model_library_snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path in ("/api/loras/download", "/api/loras/download/cancel"):
            try:
                if parsed.path.endswith("/cancel"):
                    LORA_DOWNLOAD.cancel()
                else:
                    LORA_DOWNLOAD.start(self.read_json_body().get("url"))
                self.send_json(202, LORA_DOWNLOAD.snapshot())
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/models/custom/download":
            try:
                if flux_job_snapshot()["status"] == "running":
                    raise ValueError("Stop image generation before downloading a model.")
                body = self.read_json_body()
                repo_id, family = body.get("repoId"), body.get("family")
                if not isinstance(repo_id, str) or not isinstance(family, str):
                    raise ValueError("Enter a Hugging Face repository and supported model family.")
                if any(item["state"] in ("downloading", "verifying", "preparing", "removing") for item in MODEL_MANAGER.snapshot()):
                    raise ValueError("Wait for the current model operation to finish.")
                CUSTOM_IMAGE_DOWNLOAD.start(repo_id, family)
                self.send_json(202, {"models": model_library_snapshot(), "customImageDownload": CUSTOM_IMAGE_DOWNLOAD.snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/models/custom/cancel":
            try:
                CUSTOM_IMAGE_DOWNLOAD.cancel()
                self.send_json(202, {"models": model_library_snapshot(), "customImageDownload": CUSTOM_IMAGE_DOWNLOAD.snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path in (
            "/api/models/4b/text-encoder/install",
            "/api/models/4b/text-encoder/pause",
            "/api/models/4b/text-encoder/remove",
            "/api/models/4b/text-encoder/setting",
        ):
            try:
                if flux_job_snapshot()["status"] == "running":
                    raise ValueError("Stop image generation before changing the Klein 4B text encoder.")
                model_installed = any(
                    item["id"] in ("4b", "4b-lora") and item["installed"]
                    for item in MODEL_MANAGER.snapshot()
                )
                if parsed.path.endswith("/setting"):
                    enabled = self.read_json_body().get("enabled")
                    KLEIN_TEXT_ENCODER_MANAGER.set_enabled(enabled, model_installed)
                    GENERATION_WORKER.close()
                elif parsed.path.endswith("/install"):
                    if any(
                        item["state"] in ("downloading", "verifying", "preparing", "removing")
                        for item in MODEL_MANAGER.snapshot()
                    ):
                        raise ValueError("Wait for the active model operation to finish before downloading the text encoder.")
                    KLEIN_TEXT_ENCODER_MANAGER.start(model_installed)
                elif parsed.path.endswith("/pause"):
                    KLEIN_TEXT_ENCODER_MANAGER.cancel()
                else:
                    GENERATION_WORKER.close()
                    KLEIN_TEXT_ENCODER_MANAGER.remove()
                self.send_json(200, {"models": model_library_snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path in ("/api/models/install", "/api/models/pause", "/api/models/remove"):
            try:
                model = self.read_json_body().get("model")
                if apple_silicon() != (model == APPLE_IMAGE_ID):
                    raise ValueError("This image model is unavailable on this platform.")
                if model == APPLE_IMAGE_ID and parsed.path.endswith("install") and not apple_image.device_available():
                    raise ValueError("Klein 4B · MLX requires an available Apple GPU.")
                if custom_image.is_model(model):
                    if not parsed.path.endswith("remove"):
                        raise ValueError("Custom local models are added from their export folder.")
                    with FLUX_JOB_LOCK:
                        if FLUX_JOB["status"] == "running":
                            raise ValueError("Stop generation before removing a model.")
                    CUSTOM_IMAGE_GENERATION_WORKER.close()
                    custom_entry = custom_image.model_spec(model)
                    if custom_entry.get("sourceType") == "huggingface":
                        owned_root = (MODELS_DIR / "custom-image-models").resolve()
                        owned_path = Path(custom_entry["path"]).resolve(strict=True)
                        if owned_path.parent != owned_root or not owned_path.name or owned_path == owned_root:
                            raise ValueError("Fern refused to remove model files outside its custom model storage.")
                    custom_image_registry.MODEL_REGISTRY.remove(model)
                    if custom_entry.get("sourceType") == "huggingface":
                        remove_tree(owned_path)
                    self.send_json(200, {"models": model_library_snapshot()})
                    return
                if model == flux3.MODEL_KEY:
                    if parsed.path.endswith("install"):
                        if flux_job_snapshot()["status"] == "running" or tts_job_running() or text_job_running() or text_model_install_running():
                            raise ValueError("Finish the active image, audio, or text job before setting up FLUX.3 Klein.")
                        if any(
                            item["state"] in ("downloading", "verifying", "preparing", "removing")
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
                                    remove_tree(target)
                            with QWEN_JOB_LOCK:
                                QWEN_JOB.update(
                                    status="idle", logs=[], phase=None, error=None,
                                    downloaded=0, bytes=qwen_turbo_quant_bytes(),
                                    startedAt=None, finishedAt=None,
                                )
                    self.send_json(200, {"models": model_library_snapshot()})
                    return
                model_spec(model)
                if model in INTEL_MEDIA_CATALOG:
                    if parsed.path.endswith("install") and not intel_media_supported():
                        raise ValueError(INTEL_MEDIA_PLATFORM_NOTE)
                    if parsed.path.endswith("remove"):
                        if VIDEO_JOBS.running() or text_job_running() or flux_job_snapshot()["status"] == "running":
                            raise ValueError("Finish or stop the current job before removing an Intel media model.")
                        INTEL_MEDIA.close()
                if parsed.path.endswith("install"): MODEL_MANAGER.start(model)
                elif parsed.path.endswith("pause"): MODEL_MANAGER.cancel(model)
                else:
                    if (model in flux2.KLEIN_MODEL_KEYS or model == APPLE_IMAGE_ID) and text_job_running():
                        raise ValueError("Wait for the active chat response before removing a Klein image model.")
                    with FLUX_JOB_LOCK:
                        if FLUX_JOB["status"] == "running": raise ValueError("Stop generation before removing a model.")
                    if model in ("4b", "4b-lora") and KLEIN_TEXT_ENCODER_MANAGER.snapshot(True)["state"] in ("downloading", "verifying", "preparing", "removing"):
                        raise ValueError("Cancel or finish the optional text encoder operation before removing Klein 4B.")
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
                if payload["model"] in (QWEN_TURBO_MODEL_ID, APPLE_IMAGE_ID, *INTEL_MEDIA_CATALOG)
                else flux3.model_status(payload["device"])
                if payload["model"] == flux3.MODEL_KEY
                else custom_image.model_status(payload["device"], payload["model"])
                if custom_image.is_model(payload["model"])
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
            else custom_image.model_spec(payload["model"])["label"]
            if custom_image.is_model(payload["model"])
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
        for cancel_event in (FLUX_CANCEL_EVENT, TEXT_CANCEL_EVENT):
            if cancel_event is not None:
                cancel_event.set()
        INTEL_MEDIA.interrupt()
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        CUSTOM_IMAGE_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TEXT_GENERATION_WORKER.close()
        VIDEO_JOBS.close()
        INTEL_MEDIA.close()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fern image generation API server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cors", action="store_true", help="Allow cross-origin requests (dev mode)")
    parser.add_argument("--desktop", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.desktop and os.name == "nt":
        from windows_service_job import contain_service_process_tree

        contain_service_process_tree()
    run_server(args.port, allow_cors=args.cors)


if __name__ == "__main__":
    main()
