"""Isolated modular-Diffusers compatibility overlay for the Flux.3 IR bundle."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path
from threading import Event
from typing import Callable


def _root() -> Path:
    configured = os.environ.get("FERN_ROOT", "").strip() or os.environ.get(
        "INTEL_IRIS_ROOT", ""
    ).strip()
    return Path(configured).resolve() if configured else Path(__file__).resolve().parents[1]


ROOT = _root()
RUNTIME_DIR = ROOT / ".runtime" / "flux3-klein"
SITE_PACKAGES = RUNTIME_DIR / "site-packages"
READY_FILE = RUNTIME_DIR / "runtime.json"
REQUIREMENTS = Path(__file__).with_name("requirements-flux3-klein-overlay.txt")
OVERLAY_REVISION = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def child_env(site_packages: Path = SITE_PACKAGES) -> dict[str, str]:
    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    paths = [str(site_packages)]
    if env.get("PYTHONPATH"):
        paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(paths)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["HF_HOME"] = str(ROOT / ".cache" / "huggingface-flux3-klein")
    env["HF_HUB_CACHE"] = str(Path(env["HF_HOME"]) / "hub")
    return env


def runtime_ready() -> bool:
    try:
        marker = json.loads(READY_FILE.read_text(encoding="utf-8"))
        return marker.get("requirementsSha256") == OVERLAY_REVISION and SITE_PACKAGES.is_dir()
    except (OSError, ValueError, AttributeError):
        return False


def remove_runtime() -> None:
    expected_parent = (ROOT / ".runtime").resolve()
    target = RUNTIME_DIR.resolve()
    if target.parent != expected_parent or target.name != "flux3-klein":
        raise ValueError("Invalid FLUX.3 runtime folder.")
    if target.exists():
        shutil.rmtree(target)


def ensure_runtime(
    log: Callable[[str], None], cancel_event: Event | None = None
) -> None:
    if runtime_ready():
        return
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="site-packages-", dir=RUNTIME_DIR))
    process: subprocess.Popen[str] | None = None
    pip_tail: deque[str] = deque(maxlen=24)
    try:
        command = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-deps",
            "--no-build-isolation",
            "--retries",
            "2",
            "--timeout",
            "30",
            "--target",
            str(staging),
            "-r",
            str(REQUIREMENTS),
        ]
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            env=child_env(staging),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert process.stdout is not None
        for line in process.stdout:
            if cancel_event is not None and cancel_event.is_set():
                process.terminate()
                raise InterruptedError("Flux.3 runtime setup was cancelled.")
            line = line.strip()
            if line:
                line = line[:400]
                pip_tail.append(line)
                log(line)
        code = process.wait()
        if code:
            detail = next(
                (
                    line
                    for line in reversed(pip_tail)
                    if any(
                        marker in line.lower()
                        for marker in ("error:", "failed", "cannot", "could not")
                    )
                ),
                pip_tail[-1] if pip_tail else "Pip did not report an error message.",
            )
            raise RuntimeError(
                f"Flux.3 Python runtime setup failed (pip exit {code}): {detail[:400]}"
            )

        probe_env = child_env(staging)
        probe = subprocess.run(
            [
                sys.executable,
                "-c",
                "import openvino, torch, transformers, diffusers; "
                "from diffusers import ModularPipeline; "
                "assert ModularPipeline; print('Flux.3 runtime imports ready')",
            ],
            cwd=str(ROOT),
            env=probe_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if probe.returncode:
            raise RuntimeError(
                "Flux.3 Python runtime verification failed: "
                + (probe.stderr or probe.stdout)[-3000:]
            )

        final = SITE_PACKAGES
        previous = RUNTIME_DIR / "site-packages.previous"
        if previous.exists():
            shutil.rmtree(previous)
        if final.exists():
            final.replace(previous)
        try:
            staging.replace(final)
        except Exception:
            if previous.exists() and not final.exists():
                previous.replace(final)
            raise
        marker_temp = READY_FILE.with_suffix(".tmp")
        marker_temp.write_text(
            json.dumps({"requirementsSha256": OVERLAY_REVISION}), encoding="utf-8"
        )
        marker_temp.replace(READY_FILE)
        if previous.exists():
            shutil.rmtree(previous)
        log("Flux.3 Python runtime is ready.")
    except BaseException:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
