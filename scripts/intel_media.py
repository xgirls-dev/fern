"""Pinned Fern image and video runtimes for Windows Intel GPUs."""

from __future__ import annotations

import base64
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image

from model_catalog import INTEL_MEDIA_CATALOG, installed
from sana_sprint_worker import EVENT as SANA_EVENT, PROGRESS as SANA_PROGRESS
from text_model_download import download_file
from tts_generation_worker import TtsGenerationWorker


RUNTIME = json.loads(Path(__file__).with_name("intel_media_runtime.json").read_text())
WINDOW_FLAG = getattr(subprocess, "CREATE_NO_WINDOW", 0)
PLATFORM_NOTE = "This model requires Fern on Windows x64 and an Intel GPU."
VULKAN_NOTE = "No Intel Vulkan GPU was found. Update the Intel graphics driver, restart Fern, and retry."
GPU_RESIDENCY = re.compile(r"total params memory size = .*?\(VRAM ([\d.]+)MB, RAM ([\d.]+)MB\)")
FLAGS = {
    "diffusion": "--diffusion-model", "llm": "--llm", "t5": "--t5xxl",
    "vae": "--vae", "tae": "--tae", "tokenizer": "--tokenizer",
}
VIDEO_ID = "wan22-turbo"


def supported():
    return sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"}


def check_cancel(event):
    if event.is_set():
        raise InterruptedError("Generation or setup stopped.")


def stop_process(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def run_process(command, event, log_path, *, cwd, env=None, timeout=600, update=None):
    check_cancel(event)
    with log_path.open("wb") as output:
        process = subprocess.Popen(
            command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT,
            creationflags=WINDOW_FLAG,
        )
        try:
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if event.wait(0.2):
                    check_cancel(event)
                if time.monotonic() > deadline:
                    raise RuntimeError("The Intel GPU runtime timed out. Retry the operation.")
                if update:
                    update(log_path)
        finally:
            stop_process(process)
    check_cancel(event)
    result = log_path.read_text(encoding="utf-8", errors="replace")
    if process.returncode:
        errors = [line for line in result.splitlines() if line.startswith(("[E]", SANA_EVENT, "ERROR:"))]
        detail = (errors[-1] if errors else result.strip().splitlines()[-1] if result.strip() else "")[-480:]
        raise RuntimeError(f"Intel GPU runtime exited with code {process.returncode}. {detail}".strip())
    return result


def intel_vulkan_device(executable):
    try:
        result = subprocess.run(
            [str(executable), "--list-devices"], cwd=executable.parent, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=25, creationflags=WINDOW_FLAG,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(VULKAN_NOTE) from error
    match = re.search(r"^\s*(Vulkan\d+)[\s:]+(Intel\b[^\r\n]*)", result.stdout, re.I | re.M)
    if not match and result.stderr:
        match = re.search(r"^\s*(Vulkan\d+)[\s:]+(Intel\b[^\r\n]*)", result.stderr, re.I | re.M)
    if not match or result.returncode:
        raise RuntimeError(VULKAN_NOTE)
    return match.group(1).lower(), match.group(2)


def verify_vulkan_residency(log):
    match = GPU_RESIDENCY.search(log)
    if not match or float(match.group(1)) <= 0 or float(match.group(2)) != 0:
        raise RuntimeError("Vulkan could not keep all model weights on the Intel GPU. Free GPU memory and retry.")


def sana_env(overlay):
    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(overlay), env.get("PYTHONPATH"))))
    env.update(PYTHONUNBUFFERED="1", PYTHONUTF8="1", PYTHONNOUSERSITE="1", HF_HUB_OFFLINE="1")
    return env


class IntelMedia:
    def __init__(self, root):
        self.root = root
        self.models = root / "models"
        self.runtime = root / ".runtime" / f"sd-vulkan-{RUNTIME['sha256'][:12]}"
        self.sana = TtsGenerationWorker()
        self.server = None
        self.server_model = None
        self.server_origin = None
        self.server_adapter: dict[str, str | float] | None = None
        self.server_log = None
        self.server_timer = None
        self.lock = threading.RLock()

    def folder(self, model):
        return self.models / INTEL_MEDIA_CATALOG[model]["folder"]

    def runtime_ready(self):
        try:
            records = json.loads((self.runtime / "files.json").read_text())
            return {"sd-cli.exe", "sd-server.exe", "ggml-vulkan.dll", "webm.dll"} <= records.keys() and all(
                (self.runtime / name).stat().st_size == size for name, size in records.items()
            )
        except (OSError, ValueError, AttributeError):
            return False

    def ensure_runtime(self, event, log):
        with self.lock:
            if self.runtime_ready():
                return
            log("Downloading the Intel Vulkan media runtime…")
            self.runtime.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=self.runtime.parent, prefix="sd-vulkan-") as scratch:
                stage = Path(scratch)
                archive = stage / RUNTIME["file"]

                def progress(message):
                    check_cancel(event)
                    log(message)

                download_file(RUNTIME["url"], archive, {
                    "path": RUNTIME["file"], "size": RUNTIME["size"],
                    "algorithm": "sha256", "digest": RUNTIME["sha256"],
                }, progress)
                check_cancel(event)
                with zipfile.ZipFile(archive) as package:
                    package.extractall(stage / "package")
                cli = list((stage / "package").rglob("sd-cli.exe"))
                if len(cli) != 1:
                    raise RuntimeError("The verified Vulkan package is missing its executable.")
                extracted = cli[0].parent
                records = {file.name: file.stat().st_size for file in extracted.iterdir() if file.is_file()}
                if not {"sd-cli.exe", "sd-server.exe", "ggml-vulkan.dll", "webm.dll"} <= records.keys():
                    raise RuntimeError("The verified Vulkan package is incomplete.")
                (extracted / "files.json").write_text(json.dumps(records), encoding="utf-8")
                if self.runtime.exists():
                    shutil.rmtree(self.runtime)
                extracted.rename(self.runtime)

    def preflight_install(self, model, stage, event, log):
        if model not in INTEL_MEDIA_CATALOG:
            return
        if not supported():
            raise RuntimeError(PLATFORM_NOTE)
        if model != "sana-sprint":
            self.ensure_runtime(event, log)
            log("Checking for an Intel Vulkan GPU…")
            intel_vulkan_device(self.runtime / "sd-cli.exe")

    def prepare_install(self, model, stage, event, log):
        if model != "sana-sprint":
            return
        overlay = stage / ".runtime"
        if not (overlay / "ready").is_file():
            log("Installing SANA-Sprint’s isolated OpenVINO and Python dependencies…")
            if shutil.disk_usage(stage).free < 4 * 1024**3:
                raise RuntimeError("SANA-Sprint needs at least 4 GB free while installing its runtime.")
            if overlay.exists():
                shutil.rmtree(overlay)
            overlay.mkdir()
            args = [
                sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                "--no-cache-dir", "--target", str(overlay), "--retries", "2", "--timeout", "30",
            ]
            log_path = stage / "setup.log"
            req = Path(__file__).with_name("sana_sprint_requirements.txt")
            run_process(args + ["-r", str(req)], event, log_path, cwd=stage, timeout=1800)
            wheels = sorted(str(wheel) for wheel in (stage / "wheels").glob("*.whl"))
            run_process(args + ["--no-deps", *wheels], event, log_path, cwd=stage, timeout=180)
            run_process([
                sys.executable, "-c",
                "from optimum.intel.openvino import OVSanaSprintPipeline; "
                "import openvino as ov; from sana_sprint_worker import intel_device; intel_device(ov.Core())",
            ], event, log_path, cwd=Path(__file__).parent, env=sana_env(overlay), timeout=180)
            (overlay / "ready").write_text("1", encoding="utf-8")
        if not (stage / "prepared").is_dir():
            log("Preparing SANA-Sprint’s INT4 encoder…")
            run_process([
                sys.executable, "-u", str(Path(__file__).with_name("sana_sprint_worker.py")), "prepare", str(stage),
            ], event, stage / "setup.log", cwd=stage, env=sana_env(overlay), timeout=1800)
        (stage / "setup.log").unlink(missing_ok=True)

    def status(self, model, device):
        spec = INTEL_MEDIA_CATALOG[model]
        available = supported()
        present = installed(self.models, model)
        ready = available and present and device in ("AUTO", "INTEL_GPU")
        note = (
            PLATFORM_NOTE if not available else
            "This model runs on Intel GPU. Choose Intel GPU or Auto." if device not in ("AUTO", "INTEL_GPU") else
            f"Install {spec['label']} in Models before generating." if not present else
            f"{spec['runtimeBackend']} · Intel GPU"
        )
        return {
            "selectedModel": model, "modelId": spec["repo"], "modelDir": str(self.folder(model)),
            "runtimeReady": ready, "runtimeNote": note, "platformSupported": available, "requestedDevice": device,
            "selectedDevice": "INTEL_GPU" if ready else None, "modelRevision": spec["revision"],
            "runtimeBackend": spec["runtimeBackend"], "supportsReferenceImage": model == VIDEO_ID,
            "adapters": [{"id": "INTEL_GPU", "label": "Intel GPU", "available": available,
                          "runtimeReady": ready, "note": note, "supportsReferenceImage": model == VIDEO_ID}],
        }

    def arguments(self, model, event, log):
        self.ensure_runtime(event, log)
        spec = INTEL_MEDIA_CATALOG[model]
        preset = spec["preset"]
        device, gpu = intel_vulkan_device(self.runtime / "sd-cli.exe")
        log(f"Vulkan device · {gpu}")
        backend = f"te={device},vae={device},diffusion={device}"
        args = [
            "--backend", backend, "--params-backend", backend, "--auto-fit", "off",
            "--flash-attn", "off,diffusion=on", "--flow-shift", str(preset["flow_shift"]),
            "--max-vram", f"{device}={preset['gpu_budget_gib']}", "-v",
        ]
        for role, asset in spec["assets"].items():
            args.extend((FLAGS[role], str(self.folder(model) / asset)))
        if adapter := preset.get("lora"):
            directory = (self.folder(model) / adapter["path"]).parent
            args.extend(("--lora-model-dir", str(directory), "--lora-apply-mode", "at_runtime"))
        if tile := preset.get("vae_tile_size"):
            args.extend(("--vae-tiling", "--vae-tile-size", str(tile)))
        return args

    def interrupt(self):
        self.sana.interrupt()
        stop_process(self.server)

    def close(self):
        self.sana.close()
        with self.lock:
            self.close_server()

    def close_server(self):
        if self.server_timer:
            self.server_timer.cancel()
            self.server_timer = None
        stop_process(self.server)
        self.server = self.server_model = self.server_origin = self.server_adapter = None
        if self.server_log:
            self.server_log.unlink(missing_ok=True)
            self.server_log = None

    def expire_server(self, server):
        with self.lock:
            if self.server is server and self.server_timer is threading.current_thread():
                self.close_server()

    def request(self, path, payload=None, timeout=3):
        request = urllib.request.Request(
            f"{self.server_origin}{path}",
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        # The runtime is local even on a system configured with an HTTP proxy.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
            return json.load(response)

    def start_server(self, model, event, log):
        self.close_server()
        args = self.arguments(model, event, log)
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            number = port.getsockname()[1]
        self.server_origin = f"http://127.0.0.1:{number}"
        executable = self.runtime / "sd-server.exe"
        cache = self.root / ".cache"
        cache.mkdir(parents=True, exist_ok=True)
        fd, log_name = tempfile.mkstemp(prefix="sd-server-", suffix=".log", dir=cache)
        self.server_log = Path(log_name)
        with os.fdopen(fd, "wb") as output:
            self.server = subprocess.Popen(
                [str(executable), *args, "--listen-ip", "127.0.0.1", "--listen-port", str(number)],
                cwd=self.runtime, stdout=output, stderr=subprocess.STDOUT, creationflags=WINDOW_FLAG,
            )
        deadline = time.monotonic() + 180
        log(f"Loading {INTEL_MEDIA_CATALOG[model]['label']} on Intel GPU…")
        while self.server.poll() is None and time.monotonic() < deadline:
            check_cancel(event)
            try:
                self.request("/sdcpp/v1/capabilities", timeout=1)
            except (OSError, urllib.error.URLError):
                event.wait(0.2)
                continue
            verify_vulkan_residency(self.server_log.read_text(encoding="utf-8", errors="replace"))
            if adapter := INTEL_MEDIA_CATALOG[model]["preset"].get("lora"):
                expected_name = Path(adapter["path"]).name
                for item in self.request("/sdapi/v1/loras"):
                    if item["path"] == expected_name:
                        self.server_adapter = {"path": item["path"], "multiplier": adapter["strength"]}
                        break
                if self.server_adapter is None:
                    raise RuntimeError("The required LoRA adapter was not discovered by the Vulkan runtime.")
            self.server_model = model
            return
        detail = self.server_log.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        raise RuntimeError(f"Intel Vulkan could not load the image model. {detail[-1] if detail else ''}".strip())

    def generate_image(self, request, output, event, log):
        model = request["model"]
        check_cancel(event)
        started = time.perf_counter()
        if model == "sana-sprint":
            with self.lock:
                self.close_server()
            folder = self.folder(model)
            result = self.sana.generate(
                key=(model, str(folder)),
                command=[sys.executable, "-u", str(Path(__file__).with_name("sana_sprint_worker.py")),
                         "serve", str(folder / "prepared")],
                request={**{key: request[key] for key in ("prompt", "width", "height", "guidance", "steps", "seed")},
                         "output": str(output)},
                cwd=self.root, env=sana_env(folder / ".runtime"),
                log=lambda message: log(message.removeprefix(SANA_PROGRESS)),
                runtime_label="SANA-Sprint", progress_prefix=SANA_PROGRESS, event_prefix=SANA_EVENT,
            )
            started = time.perf_counter() - float(result["generationTime"])
        else:
            self.sana.close()
            with self.lock:
                if self.server_timer:
                    self.server_timer.cancel()
                    self.server_timer = None
                try:
                    if not self.server or self.server.poll() is not None or self.server_model != model:
                        self.start_server(model, event, log)
                    check_cancel(event)
                    log("Generating on Intel GPU…")
                    started = time.perf_counter()
                    settings = {
                        "prompt": request["prompt"], "width": request["width"], "height": request["height"],
                        "seed": request["seed"], "steps": request["steps"], "cfg_scale": request["guidance"],
                        "batch_size": 1, "sampler_name": "Euler",
                        "scheduler": INTEL_MEDIA_CATALOG[model]["preset"]["scheduler"],
                    }
                    adapter = self.server_adapter
                    if adapter:
                        settings["lora"] = [adapter]
                        log_offset = self.server_log.stat().st_size
                    result = self.request("/sdapi/v1/txt2img", settings, timeout=240)
                    if adapter:
                        count = INTEL_MEDIA_CATALOG[model]["preset"]["lora"]["tensor_count"]
                        with self.server_log.open("rb") as stream:
                            stream.seek(log_offset)
                            adapter_log = stream.read().decode("utf-8", errors="replace")
                        if f"({count} / {count}) LoRA tensors have been applied" not in adapter_log:
                            raise RuntimeError("The required LoRA adapter did not apply completely.")
                        log(f"Applied {count}/{count} LoRA tensors on Intel Vulkan.")
                    image = base64.b64decode(result["images"][0].split(",")[-1], validate=True)
                    output.write_bytes(image)
                    timer = threading.Timer(120, self.expire_server, args=(self.server,))
                    timer.daemon = True
                    self.server_timer = timer
                    timer.start()
                except BaseException:
                    self.close_server()
                    raise
        check_cancel(event)
        with Image.open(output) as image:
            if image.format != "PNG" or image.size != (request["width"], request["height"]):
                raise RuntimeError("The Intel runtime returned an invalid image.")
            image.verify()
        return output, time.perf_counter() - started

    def generate_video(self, request, stage, event, log):
        self.close()
        args = self.arguments(VIDEO_ID, event, log)
        spec = INTEL_MEDIA_CATALOG[VIDEO_ID]
        reference = stage / "reference.png"
        width, height = spec["defaultWidth"], spec["defaultHeight"]
        request["reference"].save(reference, format="PNG")
        output = stage / "video.webm"
        log("Loading Wan 2.2 on Intel GPU…")
        started = time.perf_counter()
        phases = ("Loading Wan 2.2 on Intel GPU…", "Generating frames on Intel GPU…", "Decoding the clip…", "Writing WebM…")
        phase = 0

        def progress(path):
            nonlocal phase
            content = path.read_text(encoding="utf-8", errors="replace")
            next_phase = 0
            if "generate_video completed" in content:
                next_phase = 3
            elif "vae decode graph" in content:
                next_phase = 2
            elif "total params memory size" in content:
                next_phase = 1
            if next_phase > phase:
                phase = next_phase
                log(phases[phase])

        details = run_process([
            str(self.runtime / "sd-cli.exe"), "-M", "vid_gen", *args, "--init-img", str(reference),
            "--seed", str(request["seed"]), "--steps", str(spec["defaultSteps"]), "--cfg-scale", "1",
            "--sampling-method", "euler", "--scheduler", spec["preset"]["scheduler"],
            "-W", str(width), "-H", str(height), "--video-frames", str(spec["frames"]),
            "--fps", str(spec["fps"]), "-p", request["prompt"], "-o", str(output),
        ], event, stage / "runtime.log", cwd=self.runtime, update=progress)
        verify_vulkan_residency(details)
        if f"decoded {width}x{height}x{spec['frames']}x3" not in details:
            raise RuntimeError("Wan did not return the expected frames.")
        if not output.is_file():
            raise RuntimeError("Wan did not create a video.")
        with output.open("rb") as stream:
            if stream.read(4) != b"\x1a\x45\xdf\xa3":
                raise RuntimeError("Wan did not return a playable WebM file.")
        return output, time.perf_counter() - started
