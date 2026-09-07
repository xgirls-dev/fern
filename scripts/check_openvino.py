from __future__ import annotations

import sys

def main() -> int:
    # Register the optional OpenVINO NVIDIA contrib plugin before creating Core.
    nvidia_plugin_error = ""
    try:
        import openvino_nvidia  # noqa: F401
    except Exception as exc:  # pragma: no cover - hardware-specific
        nvidia_plugin_error = str(exc)

    import openvino as ov

    core = ov.Core()
    devices = [str(device) for device in core.available_devices]

    print(f"OpenVINO: {ov.get_version()}")
    print("Available devices:")

    for device in devices:
        try:
            name = core.get_property(device, "FULL_DEVICE_NAME")
        except Exception as exc:  # pragma: no cover - hardware-specific
            name = f"unknown ({exc})"
        print(f"  - {device}: {name}")

    intel_devices = [device for device in devices if device == "GPU" or device.startswith("GPU.")]
    nvidia_devices = [
        device for device in devices if device == "NVIDIA" or device.startswith("NVIDIA.")
    ]

    if not intel_devices:
        print()
        print("Intel GPU was not detected by OpenVINO.")
    else:
        print()
        print("Intel GPU is available. Use the Intel GPU adapter in Fern.")

    if nvidia_devices:
        print(f"OpenVINO NVIDIA plugin is available: {nvidia_devices}")
    elif nvidia_plugin_error:
        print(f"OpenVINO NVIDIA plugin unavailable: {nvidia_plugin_error}")
    else:
        print("OpenVINO NVIDIA plugin is installed, but no NVIDIA device was detected.")

    return 0 if intel_devices or nvidia_devices else 1


if __name__ == "__main__":
    sys.exit(main())

