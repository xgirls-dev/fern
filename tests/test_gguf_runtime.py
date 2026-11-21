from __future__ import annotations

import io
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
from gguf_runtime import GGUFServer, VulkanDriverError, ensure_runtime, runtime_supported


class VulkanRuntimeTests(unittest.TestCase):
    def test_gguf_output_can_use_more_than_half_of_the_available_context(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend, server.device, server.context_size = "vulkan", "GPU", 4096
        server.history, server.load_options = {}, {}
        server._prompt_tokens = Mock()
        server._request = Mock()
        server.http = Mock()
        request = {"messages": [{"role": "user", "content": "Hello."}],
                   "temperature": 0, "topP": 1, "seed": 0}
        for prompt, requested, expected in ((768, 512, 512), (768, 2450, 2450), (768, 4096, 3072), (2200, 4096, 1640)):
            with self.subTest(prompt=prompt, requested=requested):
                server._prompt_tokens.return_value = prompt
                server.http.open.return_value = io.BytesIO(b"data: [DONE]\n")
                result = server.generate({**request, "maxNewTokens": requested}, Mock())
                self.assertEqual(server._request.call_args.args[1]["max_tokens"], expected)
                self.assertEqual(result["maxNewTokens"], expected)

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

    @unittest.skipIf(os.name == "nt", "requires Unix executable permissions")
    def test_mac_uses_one_verified_arm64_archive_for_metal_and_cpu(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            for name in ("llama-server", "libggml-metal.dylib", "libllama-server-impl.dylib", "libmtmd.dylib"):
                (assets / name).write_bytes(b"fixture")
            (assets / "llama-server").chmod(0o755)

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-macos-arm64.tar.gz"))
                self.assertEqual(spec["algorithm"], "sha256")
                with tarfile.open(target, "w:gz") as archive:
                    archive.add(assets, arcname="llama-b12498")

            with (
                patch("gguf_runtime.sys.platform", "darwin"),
                patch("gguf_runtime.platform.machine", return_value="arm64") as machine,
                patch("gguf_runtime.download_file", side_effect=download) as fetch,
            ):
                executable = ensure_runtime(root, "metal", Mock())
                self.assertEqual(ensure_runtime(root, "cpu", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "libmtmd.dylib").unlink()
                ensure_runtime(root, "metal", Mock())
                self.assertEqual(fetch.call_count, 2)
                machine.return_value = "x86_64"
                self.assertFalse(runtime_supported())

    def test_metal_does_not_pick_a_cpu_device(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend = "metal"
        server.device = "GPU"
        result = subprocess.CompletedProcess([], 0, stdout="Available devices:\n  MTL0: Apple M1\n", stderr="")
        with patch("gguf_runtime.subprocess.run", return_value=result):
            self.assertEqual(server._select_device(Path("llama-server"), {}, 0), "MTL0")
            result.stdout = "Available devices:\n"
            with self.assertRaisesRegex(RuntimeError, "could not find an Apple GPU"):
                server._select_device(Path("llama-server"), {}, 0)

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
