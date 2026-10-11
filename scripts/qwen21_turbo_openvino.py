"""Export and run official Qwen Image 2.1 Turbo with notebook-aligned OpenVINO INT8."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODEL_ID = "Qwen/Qwen-Image-2.1-Turbo"
MODEL_REVISION = "84d3f71fff32fc6c4740b89f5556657d0c65af27"
MARKER = ".fern-qwen21-turbo-openvino.json"
ROOT = Path(os.environ.get("FERN_ROOT", Path(__file__).resolve().parents[1])).resolve()
SCRIPTS = Path(__file__).resolve().parent
EXPORT_RUNTIME = ROOT / ".venv-qwen21-export"
TURBO_RUNTIME = ROOT / ".venv-qwen21-turbo-export"
EXPORT_PYTHON = EXPORT_RUNTIME / "Scripts" / "python.exe"
TURBO_PYTHON = TURBO_RUNTIME / "Scripts" / "python.exe"


def turbo_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    env.pop("PYTHONHOME", None)
    overlay_site = TURBO_RUNTIME / "Lib" / "site-packages"
    export_site = EXPORT_RUNTIME / "Lib" / "site-packages"
    env["PYTHONPATH"] = os.pathsep.join((str(overlay_site), str(export_site)))
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def inference_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    env.pop("PYTHONHOME", None)
    python_paths = [
        TURBO_RUNTIME / "Lib" / "site-packages",
        EXPORT_RUNTIME / "Lib" / "site-packages",
        env.get("PYTHONPATH"),
    ]
    env["PYTHONPATH"] = os.pathsep.join(str(path) for path in python_paths if path)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run_stream(command: list[str], env: dict[str, str] | None = None) -> None:
    result = subprocess.run(
        command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
        stdout=sys.stdout, stderr=subprocess.STDOUT, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Command exited with status {result.returncode}: {Path(command[0]).name}")


def runtime_probe(python: Path, env: dict[str, str] | None = None) -> bool:
    if not python.is_file():
        return False
    code = "import torch, openvino; from optimum.commands.optimum_cli import main; assert main"
    result = subprocess.run(
        [str(python), "-c", code], cwd=ROOT, env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode:
        detail = (result.stdout + result.stderr)[-5000:].strip()
        print("FERN_QWEN_PROGRESS:Exporter runtime import check failed: " + detail, flush=True)
    return result.returncode == 0


def turbo_probe() -> bool:
    if not TURBO_PYTHON.is_file() or not Path(sys.executable).is_file():
        return False
    code = (
        "import diffusers, transformers, huggingface_hub; "
        "import transformers.models.qwen2_vl.modeling_qwen2_vl as qwen2_vl; "
        "qwen2_vl.VisionRotaryEmbedding = qwen2_vl.Qwen2VLRotaryEmbedding; "
        "import transformers.models.qwen3_vl.modeling_qwen3_vl as qwen3_vl; "
        "import transformers.models.qwen3_5.modeling_qwen3_5 as qwen3_5; "
        "from transformers.vision_utils import get_vision_position_ids; "
        "_rot=lambda self,grid:(get_vision_position_ids(grid,self.spatial_merge_size).unsqueeze(-1)*self.rotary_pos_emb.inv_freq).flatten(1); "
        "qwen3_vl.Qwen3VLVisionModel.rot_pos_emb=_rot; qwen3_5.Qwen3_5VisionModel.rot_pos_emb=_rot; "
        "from diffusers import QwenImage21Pipeline; "
        "from optimum.intel import OVQwenImage21Pipeline; "
        "assert transformers.__version__ == '5.17.0'; "
        "assert QwenImage21Pipeline is not None and OVQwenImage21Pipeline is not None"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, env=inference_env(),
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode:
        detail = (result.stdout + result.stderr)[-5000:].strip()
        print("FERN_QWEN_PROGRESS:Turbo inference import check failed: " + detail, flush=True)
    return result.returncode == 0


def apply_transformer_aliases() -> None:
    # Compatibility aliases from the prior Turbo OpenVINO export.
    sys.modules["torchaudio"] = None
    import transformers.models.qwen2_vl.modeling_qwen2_vl as qwen2_vl
    qwen2_vl.VisionRotaryEmbedding = qwen2_vl.Qwen2VLRotaryEmbedding
    import transformers.models.qwen3_vl.modeling_qwen3_vl as qwen3_vl
    import transformers.models.qwen3_5.modeling_qwen3_5 as qwen3_5
    from transformers.vision_utils import get_vision_position_ids

    def rot_pos_emb(self, grid):
        return (
            get_vision_position_ids(grid, self.spatial_merge_size).unsqueeze(-1)
            * self.rotary_pos_emb.inv_freq
        ).flatten(1)

    qwen3_vl.Qwen3VLVisionModel.rot_pos_emb = rot_pos_emb
    qwen3_5.Qwen3_5VisionModel.rot_pos_emb = rot_pos_emb


def apply_hub_export_compatibility() -> None:
    # The notebook exporter predates Hub 1.x's removal of HfFolder and version
    # detection assumptions. Keep this narrow adapter from the prior export.
    import importlib.metadata
    import huggingface_hub

    if not hasattr(huggingface_hub, "HfFolder"):
        class HfFolder:
            @staticmethod
            def get_token():
                return huggingface_hub.get_token()

        huggingface_hub.HfFolder = HfFolder
    original_version = importlib.metadata.version

    def compatible_version(name: str) -> str:
        if name == "huggingface-hub":
            return "0.99.0"
        return original_version(name)

    importlib.metadata.version = compatible_version


def install_memory_aware_export() -> tuple[object, object, object]:
    """Release each large PyTorch component after Optimum exports it."""
    import gc
    import optimum.exporters.openvino.convert as convert

    original_get_models = convert.get_qwen_image21_models_for_export
    original_export_models = convert.export_models
    state: dict[str, object] = {"pipeline": None}

    def capture_pipeline(pipeline, exporter, int_dtype, float_dtype):
        state["pipeline"] = pipeline
        return original_get_models(pipeline, exporter, int_dtype, float_dtype)

    def export_one_at_a_time(
        models_and_export_configs, output_dir, output_names=None, device="cpu",
        input_shapes=None, model_kwargs=None, ov_config=None, stateful=True,
        patch_16bit_model=False, library_name=None,
    ):
        input_names_by_model: list[list[str]] = []
        output_names_by_model: list[list[str]] = []
        export_flags_by_model: list[list[bool]] = []
        names = list(models_and_export_configs)
        pipeline = state["pipeline"]
        for index, name in enumerate(names):
            model, export_config = models_and_export_configs[name]
            one_stateful = stateful[index] if isinstance(stateful, (list, tuple)) else stateful
            one_output_name = [output_names[index]] if output_names is not None else None
            exported = original_export_models(
                {name: (model, export_config)}, output_dir=output_dir,
                output_names=one_output_name, device=device, input_shapes=input_shapes,
                model_kwargs=model_kwargs, ov_config=ov_config, stateful=one_stateful,
                patch_16bit_model=patch_16bit_model, library_name=library_name,
            )
            inputs, outputs, export_flags = exported
            input_names_by_model.extend(inputs)
            output_names_by_model.extend(outputs)
            export_flags_by_model.extend(export_flags)
            models_and_export_configs[name] = (None, export_config)
            if pipeline is not None:
                # The pipeline config and preprocessors are saved before this
                # function is called. Drop full-precision modules as soon as
                # their final IR component has been traced.
                if name == "transformer":
                    pipeline.transformer = None
                elif name == "vae_decoder":
                    pipeline.vae = None
                elif name == "text_encoder_i2i":
                    pipeline.text_encoder = None
            del model, export_config
            gc.collect()
        return input_names_by_model, output_names_by_model, export_flags_by_model

    convert.get_qwen_image21_models_for_export = capture_pipeline
    convert.export_models = export_one_at_a_time
    return convert, original_get_models, original_export_models


def ensure_export_runtime() -> None:
    base_python = Path(sys.executable)
    if not runtime_probe(EXPORT_PYTHON):
        print("FERN_QWEN_PROGRESS:Preparing the isolated OpenVINO notebook export environment.", flush=True)
        if not EXPORT_PYTHON.is_file():
            run_stream([str(base_python), "-m", "venv", str(EXPORT_RUNTIME)])
        run_stream([
            str(EXPORT_PYTHON), "-m", "pip", "install", "-r",
            str(SCRIPTS / "requirements-qwen21-turbo-export.txt"),
        ])
    if not turbo_probe():
        print("FERN_QWEN_PROGRESS:Preparing the isolated official Turbo compatibility overlay.", flush=True)
        if not TURBO_PYTHON.is_file():
            run_stream([str(base_python), "-m", "venv", str(TURBO_RUNTIME)])
        run_stream([
            str(TURBO_PYTHON), "-m", "pip", "install", "--no-deps", "-r",
            str(SCRIPTS / "requirements-qwen21-turbo-overlay.txt"),
        ])
    if not runtime_probe(EXPORT_PYTHON) or not turbo_probe():
        raise RuntimeError("The isolated OpenVINO/Turbo environments failed their package import checks.")


def load_checkpoint(source_root: Path) -> tuple[Path, list[float]]:
    from huggingface_hub import snapshot_download

    source_root.mkdir(parents=True, exist_ok=True)
    snapshot = Path(snapshot_download(
        repo_id=MODEL_ID, revision=MODEL_REVISION, cache_dir=str(source_root),
    ))
    config_path = snapshot / "model_index.json"
    if not config_path.is_file():
        raise RuntimeError(f"Checkpoint config is missing: {config_path}")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    sigmas = config.get("sample_sigmas")
    if not isinstance(sigmas, list) or len(sigmas) != 8:
        raise RuntimeError("The pinned official checkpoint does not contain its eight-step sample_sigmas grid.")
    return snapshot, [float(value) for value in sigmas]


def export_worker(snapshot: Path, output_dir: Path) -> None:
    if output_dir.exists():
        raise RuntimeError(f"Refusing to overwrite an existing export directory: {output_dir}")

    # Retain the exact model-family compatibility aliases from the earlier
    # Turbo export before applying its Qwen 2.1 OpenVINO exporter patches.
    apply_transformer_aliases()
    apply_hub_export_compatibility()
    from optimum.intel import OVQwenImage21Pipeline, OVWeightQuantizationConfig
    import torch

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    # Use the same Diffusers pipeline export path recorded in the previous
    # Turbo experiment, with notebook-matched FP16 source weights. The CLI
    # path defaults to FP32; on this machine that trace stalled after paging
    # past 59 GB of committed memory. The explicit dtype keeps the source
    # model load bounded while still producing weight-only OpenVINO INT8.
    quantization = OVWeightQuantizationConfig(bits=8)
    convert, original_get_models, original_export_models = install_memory_aware_export()
    try:
        pipeline = OVQwenImage21Pipeline.from_pretrained(
            str(snapshot), export=True, device="CPU", torch_dtype=torch.float16,
            quantization_config=quantization, low_cpu_mem_usage=True,
        )
        pipeline.save_pretrained(output_dir)
    finally:
        convert.get_qwen_image21_models_for_export = original_get_models
        convert.export_models = original_export_models
    (output_dir / ".openvino_export_complete").write_text(
        f"model_id={MODEL_ID}\nrevision={MODEL_REVISION}\nweight_format=INT8\n",
        encoding="utf-8",
    )


def verify_worker(model_dir: Path) -> dict:
    import numpy as np
    import openvino as ov
    import torch
    apply_transformer_aliases()
    from optimum.intel import OVQwenImage21Pipeline

    config = json.loads((model_dir / "model_index.json").read_text(encoding="utf-8"))
    sigmas = config.get("sample_sigmas")
    if not isinstance(sigmas, list) or len(sigmas) != 8:
        raise RuntimeError("The exported pipeline did not retain the checkpoint's eight-step sigma grid.")
    if "GPU" not in ov.Core().available_devices:
        raise RuntimeError("OpenVINO GPU is unavailable for the required validation generation.")
    # Optimum sets per-component GPU CACHE_DIR paths but does not create them
    # before the OpenVINO runtime canonicalizes the path on Windows.
    for component in ("text_encoder", "text_encoder_i2i", "transformer", "vision_encoder", "vae_encoder", "vae_decoder"):
        (model_dir / component / "model_cache").mkdir(parents=True, exist_ok=True)
    print("FERN_QWEN_PROGRESS:Validating the INT8 export with the official eight-step GPU schedule.", flush=True)
    pipe = OVQwenImage21Pipeline.from_pretrained(str(model_dir), device="GPU")
    result = pipe(
        prompt="A photorealistic red apple on a wooden table, natural light.",
        width=512, height=512, num_inference_steps=8, sigmas=sigmas,
        true_cfg_scale=1.0, use_kv_cache=False,
        generator=torch.Generator("cpu").manual_seed(9252026),
    )
    image = result.images[0].convert("RGB")
    pixels = np.asarray(image)
    deviation = float(pixels.std())
    if image.size != (512, 512) or deviation < 0.5 or not np.isfinite(pixels).all():
        raise RuntimeError(f"OpenVINO validation image is invalid: size={image.size}, std={deviation:.3f}")
    image_path = model_dir / ".fern-validation.png"
    image.save(image_path)
    evidence = {
        "prompt": "A photorealistic red apple on a wooden table, natural light.",
        "seed": 9252026, "width": 512, "height": 512, "steps": 8,
        "trueCfgScale": 1.0, "useKvCache": False, "device": "GPU", "sampleSigmas": sigmas,
        "pixelStdDev": deviation,
        "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
    }
    (model_dir / ".fern-validation.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print("FERN_QWEN_PROGRESS:OpenVINO Turbo GPU validation passed.", flush=True)
    return evidence


def setup_model(source_root: Path, model_dir: Path) -> None:
    ensure_export_runtime()
    snapshot, sigmas = load_checkpoint(source_root)
    if model_dir.exists():
        raise RuntimeError(f"Refusing to overwrite an existing model path: {model_dir}")
    partial = model_dir.with_name(model_dir.name + ".partial")
    if partial.exists():
        if not (partial / ".openvino_export_complete").is_file():
            raise RuntimeError(f"An incomplete export is preserved at {partial}; inspect it before retrying.")
        print("FERN_QWEN_PROGRESS:Resuming validation of the completed INT8 export.", flush=True)
    else:
        print("FERN_QWEN_PROGRESS:Exporting the official checkpoint with the documented Optimum INT8 workflow.", flush=True)
        run_stream([
            str(TURBO_PYTHON), "-u", str(Path(__file__).resolve()),
            "export-worker", str(snapshot), str(partial),
        ], env=turbo_env())
    required = (
        "model_index.json", "transformer/openvino_model.xml", "transformer/openvino_model.bin",
        "text_encoder/openvino_model.xml", "text_encoder_i2i/openvino_model.xml",
        "vision_encoder/openvino_model.xml", "vae_encoder/openvino_model.xml",
        "vae_decoder/openvino_model.xml",
    )
    missing = [name for name in required if not (partial / name).is_file()]
    if missing:
        raise RuntimeError("INT8 export is incomplete; preserved partial output is missing: " + ", ".join(missing))
    # Some Optimum releases omit unrecognized pipeline config fields on save.
    # Restore the official schedule explicitly before validation and runtime use.
    exported_config_path = partial / "model_index.json"
    exported_config = json.loads(exported_config_path.read_text(encoding="utf-8"))
    exported_config["sample_sigmas"] = sigmas
    exported_config_path.write_text(json.dumps(exported_config, indent=2) + "\n", encoding="utf-8")
    (partial / ".fern-sample-sigmas.json").write_text(
        json.dumps({"sample_sigmas": sigmas}, indent=2), encoding="utf-8",
    )
    evidence_path = partial / ".fern-validation.json"
    result = subprocess.run(
        [sys.executable, "-u", str(Path(__file__).resolve()), "verify-worker", str(partial)],
        cwd=ROOT, env=inference_env(), stdout=sys.stdout, stderr=subprocess.STDOUT, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"OpenVINO validation failed with status {result.returncode}; partial export preserved at {partial}")
    if not evidence_path.is_file():
        raise RuntimeError("OpenVINO validation did not write its evidence file.")
    marker = {
        "repo": MODEL_ID, "revision": MODEL_REVISION, "format": "openvino-int8",
        "weightBits": 8, "exporter": "optimum-intel notebook-compatible CLI",
        "pipelineClass": "OVQwenImage21Pipeline",
    }
    (partial / MARKER).write_text(json.dumps(marker, indent=2), encoding="utf-8")
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    partial.replace(model_dir)
    print("FERN_QWEN_PROGRESS:OpenVINO INT8 export and GPU validation are complete.", flush=True)


def serve(model_dir: Path, output_dir: Path, device: str) -> None:
    import numpy as np
    import openvino as ov
    import torch
    from PIL import Image
    apply_transformer_aliases()
    from optimum.intel import OVQwenImage21Pipeline

    if device != "CPU" and "GPU" not in ov.Core().available_devices:
        raise RuntimeError("OpenVINO GPU is unavailable. Select CPU explicitly to continue.")
    pipe = None
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if pipe is None:
                print("FERN_QWEN_PROGRESS:Loading the OpenVINO INT8 pipeline.", flush=True)
                pipe = OVQwenImage21Pipeline.from_pretrained(str(model_dir), device=device)
                pipe.set_progress_bar_config(disable=True)
            name = str(req["outputName"])
            if Path(name).name != name or not name.lower().endswith(".png"):
                raise ValueError("Invalid output filename.")
            output = output_dir / name
            if output.exists():
                raise ValueError("Refusing to overwrite an existing image.")
            reference = None
            if req.get("referencePath"):
                with Image.open(req["referencePath"]) as opened:
                    reference = opened.convert("RGBA")
            start = time.perf_counter()
            sigmas = json.loads((model_dir / ".fern-sample-sigmas.json").read_text(encoding="utf-8"))["sample_sigmas"]

            def report_step(_pipeline, step, _timestep, callback_kwargs):
                print(f"FERN_QWEN_PROGRESS:Step {step + 1}/8", flush=True)
                return callback_kwargs

            result = pipe(
                prompt=str(req["prompt"]), image=reference,
                width=int(req["width"]), height=int(req["height"]),
                num_inference_steps=8, sigmas=sigmas, true_cfg_scale=1.0,
                use_kv_cache=False, callback_on_step_end=report_step,
                generator=torch.Generator("cpu").manual_seed(int(req["seed"])),
            )
            image = result.images[0]
            pixels = np.asarray(image.convert("RGB"))
            if not np.isfinite(pixels).all() or float(pixels.std()) < 0.5:
                raise RuntimeError("Invalid or flat output rejected.")
            output_dir.mkdir(parents=True, exist_ok=True)
            image.save(output)
            elapsed = round(time.perf_counter() - start, 1)
            metadata = {
                "model": MODEL_ID, "modelRevision": MODEL_REVISION, "format": "OpenVINO INT8",
                "prompt": str(req["prompt"]), "seed": int(req["seed"]),
                "width": image.width, "height": image.height, "steps": 8,
                "trueCfgScale": 1.0, "useKvCache": False,
                "sampleSigmas": sigmas, "device": device,
                "referenceUsed": reference is not None, "generationTime": elapsed,
                "std": float(pixels.std()),
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            }
            output.with_suffix(".json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            print("FERN_QWEN_EVENT:" + json.dumps({"path": str(output), "generationTime": elapsed}), flush=True)
        except Exception as exc:
            print("FERN_QWEN_EVENT:" + json.dumps({"error": str(exc)}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    setup = sub.add_parser("setup")
    setup.add_argument("source", type=Path)
    setup.add_argument("model", type=Path)
    worker = sub.add_parser("export-worker")
    worker.add_argument("source", type=Path)
    worker.add_argument("output", type=Path)
    verify = sub.add_parser("verify-worker")
    verify.add_argument("model", type=Path)
    sub.add_parser("probe")
    sub.add_parser("repair-runtime")
    run = sub.add_parser("serve")
    run.add_argument("model", type=Path)
    run.add_argument("outputs", type=Path)
    run.add_argument("--device", default="GPU")
    args = parser.parse_args()
    if args.command == "setup":
        setup_model(args.source.resolve(), args.model.resolve())
    elif args.command == "export-worker":
        export_worker(args.source.resolve(), args.output.resolve())
    elif args.command == "verify-worker":
        verify_worker(args.model.resolve())
    elif args.command == "probe":
        print("base runtime ready:", runtime_probe(EXPORT_PYTHON), flush=True)
        print("Turbo overlay ready:", turbo_probe(), flush=True)
    elif args.command == "repair-runtime":
        ensure_export_runtime()
    else:
        serve(args.model.resolve(), args.outputs.resolve(), args.device)


if __name__ == "__main__":
    main()
