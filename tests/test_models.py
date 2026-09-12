import sys, tempfile, unittest, hashlib, io, time
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import model_manager as mm
import flux2_klein_pipeline as flux
import model_capabilities as capabilities
from model_catalog import CATALOG


class Response(io.BytesIO):
    status = 200


class ModelsTests(unittest.TestCase):
    def test_memory_telemetry_keeps_host_and_gpu_capacity_separate(self):
        with patch.object(
            capabilities,
            "system_memory",
            return_value={"totalBytes": 32 * 1024**3, "availableBytes": 1024**3},
        ):
            self.assertEqual(capabilities.device_memory(None, "CPU"), 32 * 1024**3)
            for capacity in (8 * 1024**3, 16 * 1024**3):
                core = Mock()
                core.get_property.return_value = capacity
                self.assertEqual(capabilities.device_memory(core, "GPU"), capacity)
            core.get_property.side_effect = RuntimeError("Unsupported property")
            self.assertIsNone(capabilities.device_memory(core, "GPU"))

    def test_auto_uses_installed_models(self):
        self.assertEqual(capabilities.choose_model("auto", ["9b"]), "9b")
        self.assertEqual(capabilities.choose_model("auto", ["4b"]), "4b")
        self.assertEqual(capabilities.choose_model("auto", ["4b", "9b"]), "9b")

    def test_pinned_catalog_and_isolation(self):
        self.assertNotEqual(CATALOG["9b"]["folder"], CATALOG["4b"]["folder"])
        for spec in CATALOG.values():
            self.assertEqual(len(spec["revision"]), 40)
            self.assertTrue(
                any(
                    f["path"] == "vae_encoder/openvino_model.bin" for f in spec["files"]
                )
            )

    def test_installer_verifies_then_publishes(self):
        data = b"fixture model"
        spec = {
            "id": "4b",
            "label": "Klein 4B",
            "repo": "test/repo",
            "folder": "model4",
            "revision": "a" * 40,
            "files": [
                {
                    "path": "weights.bin",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "blob": "",
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            mm.CATALOG, {"4b": spec}
        ), patch("model_manager.urllib.request.urlopen", return_value=Response(data)):
            manager = mm.ModelManager(tmp)
            manager.start("4b")
            deadline = time.monotonic() + 3
            while (
                manager.jobs["4b"]["state"] in ("downloading", "verifying")
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            self.assertEqual(manager.jobs["4b"]["state"], "installed")
            self.assertTrue((Path(tmp) / "model4/.fern-model.json").exists())
            self.assertFalse((Path(tmp) / "model4.download").exists())

    def test_bad_checksum_never_installed(self):
        data = b"broken"
        spec = {
            "id": "4b",
            "label": "Klein 4B",
            "repo": "test/repo",
            "folder": "model4",
            "revision": "a" * 40,
            "files": [
                {
                    "path": "weights.bin",
                    "size": len(data),
                    "sha256": "0" * 64,
                    "blob": "",
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            mm.CATALOG, {"4b": spec}
        ), patch("model_manager.urllib.request.urlopen", return_value=Response(data)):
            manager = mm.ModelManager(tmp)
            manager.start("4b")
            deadline = time.monotonic() + 3
            while (
                manager.jobs["4b"]["state"] in ("downloading", "verifying")
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            self.assertEqual(manager.jobs["4b"]["state"], "failed")
            self.assertFalse((Path(tmp) / "model4").exists())

    def test_memory_estimate_does_not_disable_installed_model(self):
        def adapters(model="9b"):
            return [
                {
                    "id": key,
                    "runtimeReady": True,
                    "available": True,
                    "note": "Ready",
                    "runtimeBackend": key,
                    "supportsReferenceImage": True,
                }
                for key in ("INTEL_GPU", "NVIDIA_GPU", "CPU")
            ]

        state = {
            "memory": {
                "INTEL_GPU": 6 * 10**9,
                "NVIDIA_GPU": 6 * 10**9,
                "CPU": 32 * 10**9,
            }
        }
        with patch.object(
            flux, "_adapter_statuses", side_effect=adapters
        ), patch.object(flux, "_OPENVINO_DEPENDENCY_STATUS", state), patch.object(
            flux, "_NVIDIA_DEPENDENCY_STATUS", None
        ):
            result = flux.model_status("AUTO", "auto")
            self.assertEqual(result["selectedModel"], "9b")
            self.assertNotEqual(result["selectedDevice"], "CPU")
            explicit = flux.model_status("INTEL_GPU", "9b")
            self.assertTrue(explicit["runtimeReady"])
            self.assertEqual(explicit["selectedModel"], "9b")
            for reading in (0, 1, None):
                state["memory"]["INTEL_GPU"] = reading
                self.assertTrue(flux.model_status("INTEL_GPU", "9b")["runtimeReady"])
            unavailable = adapters()
            for adapter in unavailable:
                adapter["runtimeReady"] = False
                adapter["note"] = "Model or runtime missing"
            with patch.object(flux, "_adapter_statuses", return_value=unavailable):
                self.assertFalse(flux.model_status("INTEL_GPU", "9b")["runtimeReady"])

    def test_pause_and_resume_keeps_verified_install_atomic(self):
        import threading

        data = b"x" * (2 * 1024 * 1024)
        spec = {
            "id": "4b",
            "label": "Klein 4B",
            "repo": "test/repo",
            "folder": "model4",
            "revision": "a" * 40,
            "files": [
                {
                    "path": "weights.bin",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "blob": "",
                }
            ],
        }
        event = threading.Event()

        class PausingResponse(Response):
            def read(self, n=-1):
                value = super().read(n)
                event.set()
                return value

        with tempfile.TemporaryDirectory() as tmp, patch.dict(mm.CATALOG, {"4b": spec}):
            manager = mm.ModelManager(tmp)
            manager.jobs["4b"] = {"state": "downloading", "downloaded": 0}
            with patch(
                "model_manager.urllib.request.urlopen",
                return_value=PausingResponse(data),
            ):
                manager._download("4b", event)
            self.assertEqual(manager.jobs["4b"]["state"], "paused")
            partial = Path(tmp) / "model4.download/weights.bin"
            self.assertEqual(partial.stat().st_size, 1024 * 1024)
            self.assertFalse((Path(tmp) / "model4").exists())

            def resume(request, **kwargs):
                self.assertEqual(request.get_header("Range"), "bytes=1048576-")
                response = Response(data[1024 * 1024 :])
                response.status = 206
                return response

            with patch("model_manager.urllib.request.urlopen", side_effect=resume):
                manager._download("4b", threading.Event())
            self.assertEqual(manager.jobs["4b"]["state"], "installed")
            self.assertEqual((Path(tmp) / "model4/weights.bin").read_bytes(), data)

    def test_invalid_model_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = mm.ModelManager(tmp)
            with self.assertRaises(ValueError):
                manager.start("../outside")


if __name__ == "__main__":
    unittest.main()
