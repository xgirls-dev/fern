from __future__ import annotations

import os
import shutil
import subprocess
from typing import Literal


DeviceId = Literal["AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU"]

AUTO = "AUTO"
INTEL_GPU = "INTEL_GPU"
NVIDIA_GPU = "NVIDIA_GPU"
CPU = "CPU"

DEVICE_IDS: tuple[DeviceId, ...] = (AUTO, INTEL_GPU, NVIDIA_GPU, CPU)

DEVICE_LABELS: dict[DeviceId, str] = {
    AUTO: "Auto-select",
    INTEL_GPU: "Intel GPU",
    NVIDIA_GPU: "NVIDIA GPU",
    CPU: "CPU",
}


def detect_nvidia_gpus() -> tuple[str, ...]:
    """Return NVIDIA GPU names reported by the installed NVIDIA driver.

    OpenVINO only reports NVIDIA after the optional contrib plugin has been
    imported.  That makes the plugin's device list unsuitable as the sole
    hardware probe on hybrid laptops, where Intel may still be the only
    OpenVINO device visible during startup.  ``nvidia-smi`` is installed with
    the NVIDIA driver and lets Auto-select identify the discrete GPU first.
    """

    executable = shutil.which("nvidia-smi")
    if not executable:
        return ()

    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        result = subprocess.run(
            [executable, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            check=False,
            creationflags=creationflags,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return ()

    if result.returncode != 0:
        return ()
    return tuple(line.strip() for line in result.stdout.splitlines() if line.strip())


def select_auto_device(
    *, nvidia_available: bool, intel_available: bool, cpu_available: bool
) -> DeviceId:
    """Choose the best adapter, preferring the discrete NVIDIA GPU."""

    if nvidia_available:
        return NVIDIA_GPU
    if intel_available:
        return INTEL_GPU
    if cpu_available:
        return CPU
    return CPU

LEGACY_DEVICE_ALIASES = {
    "": AUTO,
    "AUTO": AUTO,
    "GPU": INTEL_GPU,
    "INTEL": INTEL_GPU,
    "INTEL_GPU": INTEL_GPU,
    "OPENVINO_GPU": INTEL_GPU,
    "NVIDIA": NVIDIA_GPU,
    "CUDA": NVIDIA_GPU,
    "NVIDIA_GPU": NVIDIA_GPU,
    "CPU": CPU,
}


def normalize_device(value: object) -> DeviceId:
    normalized = str(value or "").strip().upper()
    return LEGACY_DEVICE_ALIASES.get(normalized, AUTO)  # type: ignore[return-value]


def device_label(value: object) -> str:
    return DEVICE_LABELS[normalize_device(value)]

