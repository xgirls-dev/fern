import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from flux2_klein_text_encoder import KleinTextEncoderManager


class SharedEncoderTests(unittest.TestCase):
    def test_existing_encoder_moves_out_of_the_standard_model_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            old = root / "flux2-klein-4b-int4" / "text_encoder_uncensored"
            old.mkdir(parents=True)
            for name in ("config.json", "openvino_model.xml", "openvino_model.bin"):
                (old / name).write_bytes(b"fixture")
            manager = KleinTextEncoderManager(root, Path(directory) / "state.json")
            self.assertFalse(old.exists())
            self.assertTrue(manager.installed())
            manager.set_enabled(True, True)
            self.assertTrue(manager.snapshot(True)["enabled"])
            self.assertEqual((manager.final_dir / "openvino_model.bin").read_bytes(), b"fixture")

    def test_genai_view_exposes_hidden_states_and_reuses_model_files(self):
        import numpy as np
        import openvino as ov
        from flux2_klein_lora import _model_with_optional_encoder

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model"
            (model / "text_encoder").mkdir(parents=True)
            (model / "transformer").mkdir()
            (model / "transformer" / "weights.bin").write_bytes(b"shared")
            (model / "model_index.json").write_text("{}")
            encoder = root / "encoder"
            encoder.mkdir()
            (encoder / "config.json").write_text(json.dumps({}))
            parameter = ov.opset13.parameter([1, 1, 7680], np.float32, name="tokens")
            graph = ov.Model([parameter], [parameter], "encoder")
            ov.save_model(graph, str(encoder / "openvino_model.xml"), compress_to_fp16=False)
            view = _model_with_optional_encoder(model, encoder, root / "view")
            converted = ov.Core().read_model(str(view / "text_encoder" / "openvino_model.xml"))
            names = {name for output in converted.outputs for name in output.get_names()}
            self.assertTrue({"hidden_states.9", "hidden_states.18", "hidden_states.27"}.issubset(names))
            self.assertTrue(os.path.samefile(model / "transformer" / "weights.bin", view / "transformer" / "weights.bin"))


if __name__ == "__main__":
    unittest.main()
