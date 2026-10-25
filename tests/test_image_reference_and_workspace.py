from __future__ import annotations

import base64
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import api_server
import flux2_klein_pipeline as flux2
import tame_pony_pipeline as pony
import custom_image_pipeline as custom


def reference(color):
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


class ReferenceAndWorkspaceTests(unittest.TestCase):
    def test_pony_auto_device_check_uses_the_selected_quantization(self):
        pipeline = object()
        with patch.object(pony, "model_status", return_value={"selectedDevice": "INTEL_GPU"}) as status, patch.object(pony, "installed", return_value=True), patch.object(pony, "_PIPELINE", pipeline), patch.object(pony, "_PIPELINE_DEVICE", "INTEL_GPU"), patch.object(pony, "_PIPELINE_MODEL_KEY", pony.INT8_MODEL_KEY):
            self.assertIs(pony._load_pipeline("AUTO", None, pony.INT8_MODEL_KEY), pipeline)
            status.assert_called_once_with("AUTO", pony.INT8_MODEL_KEY)

    def test_pony_replaces_legacy_edm_label_with_standard_sdxl_timesteps(self):
        scheduler = type("EDMDPMSolverMultistepScheduler", (), {"config": {"beta_start": 0.00085, "beta_end": 0.012, "beta_schedule": "scaled_linear"}})()
        pipeline = SimpleNamespace(scheduler=scheduler)
        factory = MagicMock(return_value="corrected-scheduler")
        with patch.dict(sys.modules, {"diffusers": SimpleNamespace(DPMSolverMultistepScheduler=factory)}):
            pony.configure_pony_scheduler(pipeline)
        self.assertEqual(pipeline.scheduler, "corrected-scheduler")
        self.assertEqual(factory.call_args.kwargs["prediction_type"], "epsilon")
        self.assertTrue(factory.call_args.kwargs["use_karras_sigmas"])
        correct = SimpleNamespace(scheduler=SimpleNamespace())
        original = correct.scheduler
        pony.configure_pony_scheduler(correct)
        self.assertIs(correct.scheduler, original)

    def test_custom_genai_family_returns_and_reuses_its_loaded_pipeline(self):
        pipeline = object()
        factory = MagicMock(return_value=pipeline)
        spec = {"path": "/fixture", "label": "Fixture", "familyLabel": "FLUX.1", "family": "flux"}
        with patch.object(custom, "_PIPELINE", None), patch.object(custom, "_PIPELINE_KEY", None), patch.object(custom, "_PIPELINE_KIND", None), patch.object(custom, "model_spec", return_value=spec), patch.object(custom, "model_status", return_value={"selectedDevice": "INTEL_GPU"}), patch.dict(sys.modules, {"openvino_genai": SimpleNamespace(Text2ImagePipeline=factory)}):
            self.assertIs(custom._load_pipeline("custom-fixture", "INTEL_GPU", None), pipeline)
            self.assertIs(custom._load_pipeline("custom-fixture", "INTEL_GPU", None), pipeline)
            self.assertEqual(custom._PIPELINE_KIND, "genai")
            factory.assert_called_once_with("/fixture", "GPU")

    def test_pony_uses_configured_writable_root_outside_bundled_scripts(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {**os.environ, "FERN_ROOT": folder, "PYTHONPATH": str(SCRIPTS)}
            result = subprocess.run([sys.executable, "-c", "import os; from pathlib import Path; import tame_pony_pipeline as p; assert p.ROOT == Path(os.environ['FERN_ROOT']).resolve(); assert p.MODELS_ROOT.is_relative_to(p.ROOT); assert p.CACHE_DIR.is_relative_to(p.ROOT)"], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_pony_accepts_staged_output_under_configured_root_and_rejects_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stage = root / ".cache" / "generation-regression"
            stage.mkdir(parents=True)
            fake_pipeline = MagicMock(return_value=SimpleNamespace(images=[Image.new("RGB", (512, 512), "green")]))
            fake_torch = SimpleNamespace(Generator=lambda **_: SimpleNamespace(manual_seed=lambda _: None))
            with patch.object(pony, "ROOT", root), patch.object(pony, "_load_pipeline", return_value=fake_pipeline), patch.dict(sys.modules, {"torch": fake_torch}):
                output, duration = pony.generate_image(prompt="workspace regression", output_dir=stage, output_name="tame-pony-regression.png", width=512, height=512, steps=1)
                self.assertEqual(output.parent, stage.resolve())
                with Image.open(output) as image:
                    self.assertEqual(image.size, (512, 512))
                self.assertGreaterEqual(duration, 0)
                with self.assertRaisesRegex(ValueError, "generation workspace"):
                    pony.generate_image(prompt="outside", output_dir=root, output_name="tame-pony-invalid.png", width=512, height=512)

    def test_klein_references_keep_order_and_support_legacy_single_image(self):
        sources = [reference("red"), reference("blue")]
        result = api_server.validate_flux_payload({"prompt": "Combine Image 1 and Image 2", "model": "4b", "reference_images": sources})
        self.assertEqual(result["reference_sources"], sources)
        self.assertEqual([image.getpixel((0, 0)) for image in result["reference_images"]], [(255, 0, 0), (0, 0, 255)])
        legacy = api_server.validate_flux_payload({"prompt": "Edit", "reference_image": sources[0]})
        self.assertEqual(len(legacy["reference_images"]), 1)

    def test_reference_limits_and_wrong_family_rejected_before_generation(self):
        image = reference("red")
        for invalid in ([image] * 5, "not-an-array", [None], [""]):
            with self.assertRaises(ValueError):
                api_server.validate_flux_payload({"prompt": "Edit", "model": "4b", "reference_images": invalid})
        with self.assertRaisesRegex(ValueError, "FLUX.2 Klein"):
            api_server.validate_flux_payload({"prompt": "Edit", "model": pony.MODEL_KEY, "reference_images": [image, image]})

    def test_klein_passes_reference_list_to_pipeline_in_order(self):
        images = [Image.new("RGB", (32, 32), "red"), Image.new("RGB", (32, 32), "blue")]
        fake_pipeline = MagicMock(return_value=SimpleNamespace(images=[Image.new("RGB", (256, 256), "green")]))
        fake_torch = SimpleNamespace(Generator=lambda *_: SimpleNamespace(manual_seed=lambda _: None))
        with tempfile.TemporaryDirectory() as folder, patch.object(flux2, "_adapter_statuses", return_value=[]), patch.object(flux2, "_select_device", return_value="INTEL_GPU"), patch.object(flux2, "load_pipeline", return_value=fake_pipeline), patch.dict(sys.modules, {"torch": fake_torch}):
            output, _ = flux2.generate_image(prompt="Combine", model="4b", device="INTEL_GPU", reference_images=images, output_dir=Path(folder), width=256, height=256, steps=1)
            self.assertIs(fake_pipeline.call_args.kwargs["image"], images)
            self.assertTrue(output.is_file())


if __name__ == "__main__":
    unittest.main()
