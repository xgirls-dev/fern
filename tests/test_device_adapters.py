from __future__ import annotations

import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from device_adapters import (
    AUTO,
    CPU,
    INTEL_GPU,
    NVIDIA_GPU,
    detect_nvidia_gpus,
    device_label,
    normalize_device,
    select_auto_device,
)
from bootstrap_install import openvino_model_ready


class DeviceAdapterTests(unittest.TestCase):
    def test_legacy_gpu_settings_map_to_intel(self) -> None:
        self.assertEqual(normalize_device("GPU"), INTEL_GPU)
        self.assertEqual(normalize_device("OpenVINO_GPU"), INTEL_GPU)

    def test_supported_adapters_have_stable_labels(self) -> None:
        self.assertEqual(normalize_device("cuda"), NVIDIA_GPU)
        self.assertEqual(normalize_device("cpu"), CPU)
        self.assertEqual(normalize_device("unknown"), AUTO)
        self.assertEqual(device_label("NVIDIA_GPU"), "NVIDIA GPU")

    @patch("device_adapters.shutil.which", return_value="C:\\Windows\\System32\\nvidia-smi.exe")
    @patch("device_adapters.subprocess.run")
    def test_nvidia_probe_finds_discrete_gpu_on_hybrid_laptop(self, run, _which) -> None:
        run.return_value.returncode = 0
        run.return_value.stdout = "NVIDIA GeForce GTX 1660 Ti\n"

        self.assertEqual(detect_nvidia_gpus(), ("NVIDIA GeForce GTX 1660 Ti",))
        run.assert_called_once()
        self.assertIn("--query-gpu=name", run.call_args.args[0])

    @patch("device_adapters.shutil.which", return_value=None)
    def test_nvidia_probe_is_empty_without_driver_tool(self, _which) -> None:
        self.assertEqual(detect_nvidia_gpus(), ())

    def test_auto_select_prefers_nvidia_over_intel_on_hybrid_laptop(self) -> None:
        self.assertEqual(
            select_auto_device(nvidia_available=True, intel_available=True, cpu_available=True),
            NVIDIA_GPU,
        )

    def test_openvino_model_readiness_requires_all_components(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in openvino_model_files():
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_bytes(b"model")
            self.assertTrue(openvino_model_ready(root))


def openvino_model_files() -> tuple[str, ...]:
    return (
        "model_index.json",
        "transformer/openvino_model.xml",
        "transformer/openvino_model.bin",
        "text_encoder/openvino_model.xml",
        "text_encoder/openvino_model.bin",
        "vae_decoder/openvino_model.xml",
        "vae_decoder/openvino_model.bin",
    )


if __name__ == "__main__":
    unittest.main()

