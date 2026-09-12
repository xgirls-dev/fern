"""Memory telemetry, never an admission test for model loading.

Free host RAM and GPU-reported capacity are different measurements. Neither
checkpoint size nor a cached free-memory sample predicts an OpenVINO workload.
"""

import ctypes
import os


def system_memory():
    if os.name != "nt":
        try:
            page = os.sysconf("SC_PAGE_SIZE")
            return {
                "totalBytes": os.sysconf("SC_PHYS_PAGES") * page,
                "availableBytes": os.sysconf("SC_AVPHYS_PAGES") * page,
            }
        except (ValueError, OSError):
            return {"totalBytes": None, "availableBytes": None}

    class Memory(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong)
            for name in (
                "total",
                "available",
                "pageTotal",
                "pageAvailable",
                "virtualTotal",
                "virtualAvailable",
                "extended",
            )
        ]

    state = Memory()
    state.length = ctypes.sizeof(state)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(state)):
        return {"totalBytes": None, "availableBytes": None}
    return {"totalBytes": int(state.total), "availableBytes": int(state.available)}


def device_memory(core, device):
    if device == "CPU":
        return system_memory()["totalBytes"]
    try:
        # On integrated GPUs this is shared-memory telemetry, not dedicated VRAM.
        # Never substitute free host RAM or clamp discrete VRAM to free host RAM.
        reported = int(core.get_property(device, "GPU_DEVICE_TOTAL_MEM_SIZE"))
        return reported if reported > 0 else None
    except Exception:
        return None


def choose_model(preference, installed_models):
    if preference != "auto":
        return preference
    return next((key for key in ("9b", "4b") if key in installed_models), "4b")
