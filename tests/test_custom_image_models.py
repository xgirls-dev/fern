from __future__ import annotations

import sys
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import custom_image_download
import custom_image_pipeline
import custom_image_registry
import tame_pony_pipeline


def write_export(folder: Path) -> None:
    (folder / "unet").mkdir(parents=True, exist_ok=True)
    (folder / "model_index.json").write_text(
        '{"_class_name":"StableDiffusionXLPipeline"}', encoding="utf-8"
    )
    (folder / "unet" / "openvino_model.xml").write_text(
        '<net name="fixture" version="11"></net>', encoding="utf-8"
    )
    (folder / "unet" / "openvino_model.bin").write_bytes(b"fixture")


class CustomImageModelTests(unittest.TestCase):
    def test_diffusers_progress_ignores_terminal_callback(self):
        class FakePipeline:
            def set_progress_bar_config(self, **_kwargs):
                pass

            def __call__(self, **kwargs):
                callback = kwargs["callback_on_step_end"]
                for step in range(kwargs["num_inference_steps"] + 1):
                    callback(None, step, None, {})
                return SimpleNamespace(images=[Image.new("RGB", (512, 512), "black")])

        pipeline = FakePipeline()
        item = {
            "id": "custom-stable-diffusion",
            "label": "local-sd",
            "path": "C:/models/local-sd",
            "family": "stable-diffusion",
            "familyLabel": "Stable Diffusion 1.x / 2.x",
        }
        torch = ModuleType("torch")
        torch.Generator = lambda **_kwargs: SimpleNamespace(manual_seed=lambda _seed: object())
        with tempfile.TemporaryDirectory() as directory:
            logs: list[str] = []
            with patch.dict(sys.modules, {"torch": torch}), patch.object(
                custom_image_pipeline, "model_spec", return_value=item
            ), patch.object(custom_image_pipeline, "_load_pipeline", return_value=pipeline), patch.object(
                custom_image_pipeline, "_PIPELINE_KIND", "diffusers"
            ):
                custom_image_pipeline.generate_image(
                    model_id=item["id"],
                    prompt="test",
                    output_dir=Path(directory),
                    width=512,
                    height=512,
                    steps=2,
                    guidance=7,
                    seed=1,
                    device="AUTO",
                    output_name="custom-image-progress.png",
                    log=logs.append,
                )
            self.assertEqual(logs[:2], ["Step 1/2", "Step 2/2"])
            self.assertNotIn("Step 3/2", logs)
            self.assertRegex(logs[-1], r"^Completed in \d+\.\d+s\.$")

    def test_flux2_klein_custom_export_uses_optimum_intel_adapter(self):
        pipeline = SimpleNamespace(set_progress_bar_config=lambda **_kwargs: None)
        optimum_intel = ModuleType("optimum.intel")
        optimum_intel.OVFlux2KleinPipeline = SimpleNamespace(
            from_pretrained=lambda *args, **kwargs: pipeline
        )
        item = {
            "id": "custom-flux2-klein",
            "label": "local-klein",
            "path": "C:/models/local-klein",
            "family": "flux2-klein",
            "familyLabel": "FLUX.2 Klein",
        }
        ready = {"checking": False, "selectedDevice": "INTEL_GPU"}
        custom_image_pipeline.release_pipeline()
        with patch.object(custom_image_pipeline, "model_spec", return_value=item), patch.object(
            custom_image_pipeline, "model_status", return_value=ready
        ), patch.dict(sys.modules, {"optimum.intel": optimum_intel}):
            loaded = custom_image_pipeline._load_pipeline(item["id"], "AUTO", None)
        self.assertIs(loaded, pipeline)
        self.assertEqual(custom_image_pipeline._PIPELINE_KIND, "flux2-klein")
        self.assertEqual(custom_image_pipeline._PIPELINE_KEY, (item["id"], "INTEL_GPU"))
        custom_image_pipeline.release_pipeline()

    def test_sdxl_adapters_tolerate_diffusers_without_legacy_device_helper(self):
        module_name = "diffusers.pipelines.stable_diffusion_xl.pipeline_stable_diffusion_xl"
        replacement = ModuleType(module_name)
        with patch.dict(sys.modules, {module_name: replacement}):
            tame_pony_pipeline._patch_openvino_vae_device_lookup()
        with patch.object(custom_image_pipeline, "import_module", return_value=SimpleNamespace()):
            custom_image_pipeline._patch_vae_device_lookup(module_name)

    def test_inspection_requires_matching_family_and_valid_ir_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_export(folder)
            inspected = custom_image_registry.inspect_model(folder, "sdxl")
            self.assertEqual(inspected["pipelineClass"], "StableDiffusionXLPipeline")
            self.assertEqual([path.replace("\\", "/") for path in inspected["irFiles"]], [
                "unet/openvino_model.xml", "unet/openvino_model.bin"
            ])
            with self.assertRaisesRegex(ValueError, "selected family"):
                custom_image_registry.inspect_model(folder, "stable-diffusion")
            (folder / "unet" / "openvino_model.xml").write_text("<not-ir/>", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "No valid OpenVINO IR"):
                custom_image_registry.inspect_model(folder, "sdxl")

    def test_registry_marks_missing_export_repair_needed_and_preserves_local_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export = root / "external-export"
            write_export(export)
            registry = custom_image_registry.CustomImageRegistry(root / "registry.json")
            item = registry.add(str(export), "sdxl")
            registry.remove(item["id"])
            self.assertTrue((export / "model_index.json").is_file())
            item = registry.add(str(export), "sdxl")
            (export / "unet" / "openvino_model.bin").unlink()
            broken = registry.get(item["id"])
            self.assertFalse(broken["installed"])
            self.assertEqual(broken["state"], "repair-needed")

    def test_hugging_face_download_stages_validates_and_registers_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = custom_image_registry.CustomImageRegistry(root / "registry.json")
            manager = custom_image_download.CustomImageDownloadManager(root / "models")

            def fake_snapshot_download(*, repo_id, dry_run=False, local_dir=None, **_kwargs):
                self.assertEqual(repo_id, "owner/model")
                if dry_run:
                    return [SimpleNamespace(file_size=13)]
                write_export(Path(local_dir))
                return str(local_dir)

            with patch.object(custom_image_registry, "MODEL_REGISTRY", registry), patch.object(
                custom_image_download, "snapshot_download", side_effect=fake_snapshot_download
            ):
                manager.start("https://huggingface.co/owner/model", "sdxl")
                deadline = time.monotonic() + 3
                while manager.snapshot()["status"] in ("checking", "downloading", "validating") and time.monotonic() < deadline:
                    time.sleep(0.01)
                state = manager.snapshot()
                self.assertEqual(state["status"], "complete", state)
                self.assertTrue(registry.snapshot()[0]["installed"])
                self.assertEqual(registry.snapshot()[0]["repoId"], "owner/model")
                self.assertEqual(manager.root.joinpath(
                    hashlib.sha256(b"owner/model").hexdigest()[:20],
                    "model_index.json",
                ).read_text(encoding="utf-8"), '{"_class_name":"StableDiffusionXLPipeline"}')

    def test_hugging_face_download_rejects_untrusted_url_hosts(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = custom_image_download.CustomImageDownloadManager(Path(directory) / "models")
            with self.assertRaisesRegex(ValueError, "Hugging Face model URL"):
                manager.start("https://example.com/owner/model", "sdxl")


if __name__ == "__main__":
    unittest.main()
