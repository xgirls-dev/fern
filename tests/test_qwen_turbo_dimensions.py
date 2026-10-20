from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qwen21_turbo_openvino import (
    crop_qwen_turbo_output,
    qwen_turbo_inference_size,
    resolve_qwen_turbo_output_dir,
)


class QwenTurboDimensionTests(unittest.TestCase):
    def test_rounds_requested_presets_up_to_the_32_pixel_grid(self):
        self.assertEqual(qwen_turbo_inference_size(720, 1280), (736, 1280))
        self.assertEqual(qwen_turbo_inference_size(1280, 720), (1280, 736))
        self.assertEqual(qwen_turbo_inference_size(1024, 1024), (1024, 1024))

    def test_rejects_non_positive_dimensions(self):
        for dimensions in ((0, 720), (720, 0), (-32, 720)):
            with self.subTest(dimensions=dimensions), self.assertRaises(ValueError):
                qwen_turbo_inference_size(*dimensions)

    def test_center_crops_aligned_render_to_exact_requested_dimensions(self):
        image = Image.new("RGB", (736, 1280))
        image.putpixel((7, 640), (255, 0, 0))
        image.putpixel((8, 640), (0, 255, 0))
        image.putpixel((9, 640), (0, 0, 255))

        cropped = crop_qwen_turbo_output(image, 720, 1280)

        self.assertEqual(cropped.size, (720, 1280))
        self.assertEqual(cropped.getpixel((0, 640)), (0, 255, 0))
        self.assertEqual(cropped.getpixel((1, 640)), (0, 0, 255))

    def test_refuses_to_upscale_an_unexpectedly_small_pipeline_result(self):
        with self.assertRaisesRegex(ValueError, "smaller than requested"):
            crop_qwen_turbo_output(Image.new("RGB", (704, 1280)), 720, 1280)

    def test_resolves_each_request_to_its_own_cache_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first = resolve_qwen_turbo_output_dir(root, root / "generation-first")
            second = resolve_qwen_turbo_output_dir(root, root / "generation-second")
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, root)
            self.assertEqual(second.parent, root)

    def test_legacy_request_uses_job_id_from_filename_when_worker_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            stale_startup_dir = root / "generation-1700000000000"
            output_dir = resolve_qwen_turbo_output_dir(
                stale_startup_dir,
                None,
                "qwen21-turbo-1700000005000-1.png",
            )
            self.assertEqual(output_dir, root / "generation-1700000005000")

    def test_rejects_output_workspaces_outside_the_cache_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with self.assertRaisesRegex(ValueError, "under the cache root"):
                resolve_qwen_turbo_output_dir(root, root.parent / "generation-outside")
            with self.assertRaisesRegex(ValueError, "under the cache root"):
                resolve_qwen_turbo_output_dir(root, root / "not-a-generation")
            with self.assertRaisesRegex(ValueError, "invalid generation filename"):
                resolve_qwen_turbo_output_dir(root, None, "qwen21-turbo-invalid-1.png")


if __name__ == "__main__":
    unittest.main()
