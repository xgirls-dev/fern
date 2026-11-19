from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gguf_runtime import GGUFServer, VulkanDriverError, ensure_runtime


class VulkanRuntimeTests(unittest.TestCase):
    def test_download_reuse_and_repair_missing_backend_dll(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-win-vulkan-x64.zip"))
                self.assertEqual(spec["algorithm"], "sha256")
                with zipfile.ZipFile(target, "w") as archive:
                    archive.writestr("llama-server.exe", b"server")
                    archive.writestr("ggml-vulkan.dll", b"backend")
                    archive.writestr("mtmd.dll", b"vision")

            with patch("gguf_runtime.sys.platform", "win32"), \
                 patch("gguf_runtime.runtime_supported", return_value=True), \
                 patch("gguf_runtime.download_file", side_effect=download) as fetch:
                executable = ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "ggml-vulkan.dll").unlink()
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual((executable.parent / "ggml-vulkan.dll").read_bytes(), b"backend")
                (executable.parent / "mtmd.dll").write_bytes(b"")
                ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 3)
                self.assertEqual((executable.parent / "mtmd.dll").read_bytes(), b"vision")

    @unittest.skipIf(os.name == "nt", "requires Unix permissions and symlinks")
    def test_linux_tar_preserves_executable_and_repairs_shared_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            server = assets / "llama-server"
            server.write_bytes(b"server")
            server.chmod(0o755)
            (assets / "libggml-vulkan.so.1").write_bytes(b"backend")
            (assets / "libggml-vulkan.so").symlink_to("libggml-vulkan.so.1")

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-ubuntu-vulkan-x64.tar.gz"))
                with tarfile.open(target, "w:gz") as archive:
                    archive.add(assets, arcname="llama-b12498")

            with patch("gguf_runtime.sys.platform", "linux"), \
                 patch("gguf_runtime.runtime_supported", return_value=True), \
                 patch("gguf_runtime.download_file", side_effect=download) as fetch:
                executable = ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(executable.stat().st_mode & 0o100, 0o100)
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "libggml-vulkan.so.1").unlink()
                ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual((executable.parent / "libggml-vulkan.so").read_bytes(), b"backend")

    def test_missing_windows_vulkan_loader_requests_driver(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend = "vulkan"
        server.device = "GPU"
        with patch("gguf_runtime.sys.platform", "win32"), patch("gguf_runtime.ctypes.WinDLL", side_effect=OSError, create=True):
            with self.assertRaisesRegex(VulkanDriverError, "could not load Vulkan") as error:
                server._select_device(Path("llama-server.exe"), {}, 0)
        self.assertEqual(error.exception.code, "intel-vulkan-driver")

    def test_missing_intel_adapter_requests_driver(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend = "vulkan"
        server.device = "GPU"
        result = subprocess.CompletedProcess([], 1, stdout="Available devices:\n", stderr="")
        with patch("gguf_runtime.sys.platform", "win32"), patch("gguf_runtime.ctypes.WinDLL", create=True), \
             patch("gguf_runtime.subprocess.run", return_value=result):
            with self.assertRaisesRegex(VulkanDriverError, "compatible Intel GPU"):
                server._select_device(Path("llama-server.exe"), {}, 0)
