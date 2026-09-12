"""Conservative memory evidence. File weights are a rejection floor, not a fit guarantee."""

import ctypes
import os


def available_ram():
    if os.name != "nt":
        try:
            return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        except (ValueError, OSError):
            return None

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
    return (
        int(state.available)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(state))
        else None
    )


def device_memory(core, device):
    ram = available_ram()
    if device == "CPU":
        return ram
    try:
        kind = str(core.get_property(device, "DEVICE_TYPE")).lower()
        if "integrated" in kind:
            return ram
        total = int(core.get_property(device, "GPU_DEVICE_TOTAL_MEM_SIZE"))
        return min(total, ram) if ram else total
    except Exception:
        return None


def weights_bytes(spec):
    return sum(file["size"] for file in spec["files"] if file["path"].endswith(".bin"))


def choose_model(preference, installed_models, memory, specs):
    if preference != "auto":
        return preference
    eligible = [
        key
        for key in ("9b", "4b")
        if key in installed_models
        and (memory is None or weights_bytes(specs[key]) < memory)
    ]
    if eligible:
        return eligible[0]
    return "4b"
