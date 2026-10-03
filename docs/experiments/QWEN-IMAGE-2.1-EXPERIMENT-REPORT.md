# Qwen Image 2.1 and Turbo: experiment and retirement report

Recorded 2026-10-02. Scope: Fern on Windows, OpenVINO, explicit Intel GPU generation and reference-image editing. Decision: retire both image variants in their current form. **Qwen3-TTS is a separate feature and is retained.**

## Decision and evidence limits

We eventually generated real, non-flat images with regular Qwen Image 2.1 and WaveCut Turbo Image 2.1 through OpenVINO GenAI. This solved basic execution, not product suitability. Regular needed an eight-step validated profile, lengthy startup, roughly four-minute text generation, and roughly twenty-minute editing at only 512 × 512. Turbo reduced the profile to six steps but still required roughly 2.5–3.7 minutes for text generation and fifteen minutes for editing. It also did not reproduce the model card's custom sampling schedule. The owner judged the resulting quality and iteration cost unsuitable for Fern and requested retirement.

There is no controlled quality benchmark establishing the cause of every defect or proving INT8 alone caused quality loss. A standard deviation check proves an image is not uniform; it does not establish visual quality, prompt adherence, editing fidelity, or parity with the original model. Historically, API execution was verified; native Electron Qwen-image click-through, image AUTO quality, and NVIDIA execution were not fully verified. This report preserves those boundaries.

## Retained record

This report is the only retained Qwen Image experiment source artifact. No archive, local notebook checkout, archived sample images, standalone export helpers, manifests, image-specific dependency environment, or experiment scratch files are kept. Historical sample names and measurements below describe runs that occurred; they do not link to retained experiment files. Recreation instructions and the necessary compatibility recipes are included directly in this document.

Upstream references: [official Qwen Image 2.1 notebook at the recorded commit](https://github.com/openvinotoolkit/openvino_notebooks/tree/1c614ec5944a855d50f6e7eeb9d9fca1b4737629/notebooks/qwen-image-2.1), [regular model](https://huggingface.co/Qwen/Qwen-Image-2.1), and [pinned Turbo source](https://huggingface.co/WaveCut/Turbo-Image-2.1/tree/7dd5835ff53d226ad5715d3da8c720a5a9ed5c9b).

## Regular Qwen Image 2.1: what we attempted

1. Added an optional image backend alongside Flux, with catalog identity `qwen21`, a separate model directory, API dispatch, and UI selection. The first shared-worker call failed with `generate_image() got an unexpected keyword argument 'model'`; the adapter was changed to accept the shared `model` parameter.
2. Tried older generic Qwen export code and rotary/complex-tensor compatibility patches. Failures included `tensor a (32) must match tensor b (80)`, unsupported `aten::imag`, and `ComplexTypeMark`. Those approaches did not establish a usable export.
3. Attempted FP16 and INT8 conversions in dedicated folders. A conversion failed with `RuntimeError: ios_base::badbit set: iostream stream error` while only about 22 GB was free. A later clean INT8 retry had about 61 GB free. Treat disk pressure as an observed associated condition, not a uniquely proven explanation for the exception.
4. Tested actual pixels rather than accepting a model marker or pipeline load as success. Early outputs included uniform white and black images. A 900-second GPU request was still loading and had not reached inference. Increasing steps helped one old export, but an eight-step request alone was not a universal fix for an invalid export.
5. Rebased the implementation on the exact `notebooks/qwen-image-2.1` notebook, not the older `notebooks/qwen-image` or `OVQwenImagePipeline` path. Isolated dependencies in `.venv-qwen21` because Fern's Flux environment was incompatible with the required development stack.
6. Used `openvino_genai.Text2ImagePipeline` for text and `Image2ImagePipeline` for reference editing. References became RGB uint8 NHWC `openvino.Tensor` values. Editing was fixed to respect requested width and height. Dimensions had to be divisible by 32: 592 was invalid; 576 and 608 were valid.
7. Added a minimum eight-step regular profile rather than carrying over Flux's four-step setting. Added output shape/type checks and a flat-color rejection guard. Preserved actual images as the execution acceptance evidence.
8. Fixed intermittent worker JSON failures: OpenVINO could print unrelated text to stdout. Worker events were tagged `FERN_QWEN_EVENT:` and read by a background thread into a queue; only tagged messages were parsed. Cancellation terminated the isolated worker without waiting for a denoising callback.
9. Sequential Intel GPU API requests finally produced a valid text image in about 236 seconds and a valid pear reference edit in about twenty minutes. CPU was also exercised historically, but CPU performance was never a product acceptance criterion for this GPU-oriented app.

The completed local regular export was `models/qwen-image-2.1-notebook-int8-retry`. Its recorded completion marker explicitly says `model_id=Qwen/Qwen-Image-2.1` and `weight_format=INT8`. The notebook default was FP16; that must not be confused with the format of the successful local export. Partial folders were also left under `qwen-image-2.1-notebook` and `qwen-image-2.1-ov`.

## Turbo Image 2.1: what we attempted

1. Investigated `WaveCut/Turbo-Image-2.1`, described in the experiment as a merged Qwen Image 2.1/Viggle Turbo checkpoint with a Texture-Fix VAE. Pinned source revision `7dd5835ff53d226ad5715d3da8c720a5a9ed5c9b`. Downloaded into its own source folder; 26 selected files were checked against Hub metadata, about 30.86 GiB. Kept regular exports for comparison.
2. Created `.venv-qwen21-turbo` using Python 3.12.1 with system site packages and an explicit `.venv-qwen21/Lib/site-packages` overlay. Used the card's Diffusers commit `80c7ed262aeffbeb43ef13ae04baeb9b84515a69`, Transformers 5.17.0, and the regular OpenVINO/Optimum runtime. This mixed environment was fragile.
3. Export attempts hit Hugging Face Hub version requirements, renamed Qwen rotary classes (`cannot import name VisionRotaryEmbedding`), Qwen3-VL/3.5 internals, and an incompatible `torchaudio/libtorchaudio.pyd` load. Masked optional torchaudio, aliased Qwen2-VL rotary classes, patched vision positions, and applied exporter adapters for dummy inputs, rotary embeddings, and nested text configuration. Their final code is included in the recreation recipe below.
4. Exported a dedicated INT8 OpenVINO model, about 22.15 GiB, through Optimum Intel. A source-model download was never considered runnable by itself.
5. GenAI additionally required `vision_encoder` input `bilinear_indices` to be i32 rather than i64. The first in-place save failed; exported the changed IR to a new temporary directory, reloaded it to validate the input type, backed up the original XML/BIN pair, and only then replaced both files. The backup copies are included in the deletion inventory because they contain model weights.
6. Recorded complete export provenance and validated both text and edit outputs. Readiness required matching completion/provenance markers, `QwenImage21Pipeline`, tokenizer/processor, transformer, text encoders, vision encoder, VAE encoder/decoder, scheduler, and LICENSE/NOTICE.
7. Switched active catalog `qwen21` to Turbo and changed the UI preset to 512 × 512, six steps, guidance 1.0. Fixed a save failure caused by generic storage cleanup deleting an empty staging folder during pipeline loading: recreated the folder after loading.
8. Retained pipeline instances for warm requests and used a GPU compilation cache when sufficient disk headroom existed. This improved repeat behavior but added many gigabytes of cache and did not solve editing latency.

The card recipe used fp16, six steps, no guidance, and explicit sigmas `[1.0, 0.9375, 0.875, 0.75, 0.5, 0.25]`. **Our successful OpenVINO run used INT8, guidance 1.0, and the exported FlowMatchEulerDiscreteScheduler. Custom sigmas were not applied because that GenAI `generate()` interface did not accept the sigma list.** Therefore the result was not an exact reproduction of the distilled recipe, and fewer steps alone did not establish the expected Turbo speed/quality. For a future revisit, fetch and review LICENSE/NOTICE from the pinned source revision.

## What finally worked and why it was still unsuitable

| Variant / request | Device / size / steps | Recorded elapsed | Evidence |
| --- | --- | --- | --- |
| Regular text | Intel GPU, 512 × 512, 8 | approximately 236 s | `fern-api-qwen-image-2.1-20260925-024505-seed9252026.png`, pixel std 80.54 |
| Regular reference edit | Intel GPU, 512 × 512, 8 | approximately 20 min | `fern-api-edit-qwen-image-2.1-20260925-035333-seed9252028.png`, std 60.20 |
| Turbo direct text | Intel GPU, 512 × 512, 6, guidance 1, seed 42 | 219.8 s | `qwen-image-2.1-turbo-int8-512x512-6step.png`, std 35.95 |
| Turbo direct edit | Intel GPU, 512 × 512, 6, guidance 1, seed 43 | 925.4 s | `qwen-image-2.1-turbo-int8-edit-512x512-6step.png`, std 45.93 |
| Turbo later API text | Intel GPU, 512 × 512, 6 | approximately 153 s | `qwen-image-2.1-turbo-20260930-045234-seed20260931.png`, std 55.50 |

These are individual historical runs, not averaged benchmarks. The adapter's elapsed timer started after pipeline loading, so it is not a guaranteed full click-to-image latency measurement. Cold compilation/loading could add substantially more time. Future measurements must separate download, export, load, denoising, and total request time.


The decisive practical problems were slow interaction even at small resolution, very slow reference editing, unacceptable quality/iteration tradeoffs as assessed by the owner, incomplete Turbo schedule parity, unreliable early flat outputs, and considerable installation/compatibility/storage complexity. Raising steps to rescue output increases latency; reducing steps to a Flux-like profile was not validated as acceptable. Scaling these 512 px results to a larger production canvas was not demonstrated. Non-flat images did not resolve these product issues.

## Reproduction when revisiting

Recreate this as a new standalone experiment outside Fern. The removed files are not prerequisites: every local helper needed for this recipe is included below. These helpers were syntax-checked when originally prepared; the expensive export was not repeated after model deletion. A future export is not guaranteed to work unchanged because nightly wheels and upstream interfaces can disappear or change.

### 1. Create an isolated workspace and environment

Use Python 3.12. The recorded notebook repository commit is `1c614ec5944a855d50f6e7eeb9d9fca1b4737629`; fetch it afresh if you want to compare or run the notebook. The successful regular export was INT8, despite the notebook's FP16 default. Avoid modifying Fern's image or audio environments.

```powershell
$work = Join-Path $env:TEMP 'fern-qwen-image-revisit'
New-Item -ItemType Directory -Path $work -Force
Set-Location $work
py -3.12 -m venv runtime
# Save the requirements block below as requirements-image.txt in this new workspace.
& ./runtime/Scripts/python.exe -m pip install -r requirements-image.txt
```

Save this requirements block as `requirements-image.txt`:

```text
# Match openvino_notebooks/notebooks/qwen-image-2.1 installation cell.
# Keep this separate from requirements.txt so the experimental backend does not
# silently change Fern's Flux-specific dependencies.
git+https://github.com/huggingface/diffusers.git@8b3c707ebd3ec4881f4190cf42931da07eaf3b65
git+https://github.com/huggingface/optimum-intel.git@c7e9f387b3beac5d507136f35c98743ca0805d54
torch
accelerate
nncf
numpy
pillow
tqdm
--extra-index-url https://download.pytorch.org/whl/cpu
--pre
openvino==2026.5.0.dev20260919
openvino-tokenizers==2026.5.0.0.dev20260919
openvino-genai==2026.5.0.0.dev20260919
--extra-index-url https://storage.openvinotoolkit.org/simple/wheels/nightly
```

Recorded regular commits: Diffusers `8b3c707ebd3ec4881f4190cf42931da07eaf3b65`, Optimum Intel `c7e9f387b3beac5d507136f35c98743ca0805d54`. OpenVINO was `2026.5.0.dev20260919`, GenAI/tokenizers `2026.5.0.0.dev20260919`. The Torch CPU wheel was a conversion/helper dependency; image inference used OpenVINO GPU. Other relevant installed versions were:

| Historical environment | Package | Recorded version |
| --- | --- | --- |
| .venv-qwen21 | accelerate | 1.15.0 |
| .venv-qwen21 | huggingface_hub | 1.32.0 |
| .venv-qwen21 | nncf | 3.4.0 |
| .venv-qwen21 | numpy | 2.4.6 |
| .venv-qwen21 | pillow | 12.3.0 |
| .venv-qwen21 | torch | 2.14.0+cpu |
| .venv-qwen21 | transformers | 5.10.4 |
| .venv-qwen21-turbo | huggingface_hub | 1.33.0 |
| .venv-qwen21-turbo | transformers | 5.17.0 |

These are historical inventories, not a claim that the mixed Turbo environment was hermetically reproducible. Resolve conflicts explicitly and keep any changed versions in the new experiment log. Leave ample disk headroom for approximately 31 GiB of Turbo source, 22 GiB of export, temporary IR copies, and compilation caches. A failed regular conversion had only about 22 GB free; a later retry had about 61 GB free.

### 2. Recreate the export helpers from this report

Save the following as `export-compat.py` in the new workspace. These are historical adapters for the Turbo dependency combination, not modifications to Fern. They deliberately bypassed or adapted exporter assumptions; a newer upstream exporter may remove their necessity. The broad exception handling matches the experiment and can hide a patch not applying, so inspect the affected interfaces and actual export output on a future run.

```python
"""Compatibility shim for the experimental OpenVINO Qwen exporter.

The qwen-image Optimum branch still imports HfFolder, which was removed from
the Hugging Face Hub 1.x public namespace used by Diffusers main.
"""
try:
    import importlib.metadata
    _version = importlib.metadata.version
    def _patched_version(name):
        if name == "huggingface-hub":
            return "0.99.0"
        return _version(name)
    importlib.metadata.version = _patched_version
    import huggingface_hub
    if not hasattr(huggingface_hub, "HfFolder"):
        class HfFolder:
            @staticmethod
            def get_token():
                return huggingface_hub.get_token()
        huggingface_hub.HfFolder = HfFolder
except Exception:
    pass
try:
    from diffusers.configuration_utils import FrozenDict
    if not hasattr(FrozenDict, "__getattr__"):
        def _frozen_getattr(self, name):
            if name in self:
                return self[name]
            raise AttributeError(name)
        FrozenDict.__getattr__ = _frozen_getattr
except Exception:
    pass
try:
    import optimum.exporters.openvino.convert as _ov_convert
    import optimum.exporters.utils as _ov_utils
    import optimum.exporters.openvino.utils as _ov_openvino_utils
    import optimum.exporters.openvino.model_configs as _ov_configs
    _ov_utils.check_dummy_inputs_are_allowed = lambda model, dummy_input_names: None
    _ov_convert.check_dummy_inputs_are_allowed = _ov_utils.check_dummy_inputs_are_allowed
    _original_get_input_info = _ov_openvino_utils._get_input_info
    def _get_input_info_compat(model, config, dummy_inputs):
        if isinstance(dummy_inputs.get("img_shapes"), (list, tuple)):
            import torch
            patched_inputs = dict(dummy_inputs)
            patched_inputs["img_shapes"] = torch.tensor(patched_inputs["img_shapes"], dtype=torch.int64)
            return _original_get_input_info(model, config, patched_inputs)
        return _original_get_input_info(model, config, dummy_inputs)
    _ov_openvino_utils._get_input_info = _get_input_info_compat
    _ov_convert._get_input_info = _get_input_info_compat
    from diffusers.models.transformers.transformer_qwenimage21 import QwenImage21Transformer2DModel
    import diffusers.models.transformers.transformer_qwenimage21 as _qwen21_module
    _qwen21_apply_rope = _qwen21_module.apply_rotary_emb_qwen
    def _qwen21_apply_rope_compat(x, freqs_cis, use_real=True, use_real_unbind_dim=-1):
        import torch
        if not use_real and isinstance(freqs_cis, tuple):
            return _qwen21_apply_rope(x, freqs_cis, use_real=True, use_real_unbind_dim=-1)
        if not use_real and torch.is_complex(freqs_cis):
            cos = torch.repeat_interleave(freqs_cis.real, 2, dim=-1)[:, None, :]
            sin = torch.repeat_interleave(freqs_cis.imag, 2, dim=-1)[:, None, :]
            x_real, x_imag = x.reshape(*x.shape[:-1], -1, 2).unbind(-1)
            x_rotated = torch.stack([-x_imag, x_real], dim=-1).flatten(-2)
            return (x.float() * cos[None] + x_rotated.float() * sin[None]).to(x.dtype)
        return _qwen21_apply_rope(x, freqs_cis, use_real, use_real_unbind_dim)
    _qwen21_module.apply_rotary_emb_qwen = _qwen21_apply_rope_compat
    import torch.nn as nn
    class _Qwen21RopeOpenVINO(nn.Module):
        def __init__(self, rope):
            super().__init__()
            self.rope = rope
        def forward(self, img_shapes, image_pad_mask, device):
            import torch
            freqs = self.rope(img_shapes, image_pad_mask, device)
            return (torch.repeat_interleave(freqs.real, 2, dim=-1),
                    torch.repeat_interleave(freqs.imag, 2, dim=-1))
    _qwen_forward = QwenImage21Transformer2DModel.forward
    def _qwen_forward_compat(self, hidden_states, encoder_hidden_states, timestep, img_shapes, img_mask,
                             encoder_hidden_states_mask=None, attention_kwargs=None, kv_cache=None,
                             kv_cache_mode=None, return_dict=True):
        shapes = img_shapes
        if hasattr(shapes, "detach"):
            values = shapes.detach().cpu().tolist()
            if values and isinstance(values[0], int):
                native_shapes = [[tuple(int(v) for v in values)]]
            else:
                native_shapes = [[tuple(int(v) for v in row) for row in batch] for batch in values]
            img_shapes = native_shapes
        return _qwen_forward(self, hidden_states, encoder_hidden_states, timestep, img_shapes, img_mask,
                             encoder_hidden_states_mask, attention_kwargs, kv_cache, kv_cache_mode, return_dict)
    QwenImage21Transformer2DModel.forward = _qwen_forward_compat
    import optimum.exporters.openvino.model_patcher as _ov_patcher
    _qwen_patcher_enter = _ov_patcher.QwenTransfromerModelPatcher.__enter__
    def _qwen_patcher_enter_compat(self):
        result = _qwen_patcher_enter(self)
        if isinstance(self._model, QwenImage21Transformer2DModel):
            self._model.pos_embed = _Qwen21RopeOpenVINO(self._model._org_pos_embed)
            for layer in self._model.transformer_blocks:
                layer.attn.processor = layer.attn._orig_processor
        return result
    _ov_patcher.QwenTransfromerModelPatcher.__enter__ = _qwen_patcher_enter_compat
    _qwen_input_generator = _ov_configs.DummyQwenTransformerInputGenerator
    _qwen_input_generator.SUPPORTED_INPUT_NAMES = tuple(
        list(_qwen_input_generator.SUPPORTED_INPUT_NAMES) + ["img_mask"]
    )
    _qwen_original_generate = _qwen_input_generator.generate
    def _qwen_generate(self, input_name, framework="pt", int_dtype="int64", float_dtype="fp32"):
        if input_name == "img_mask":
            import torch
            return torch.cat(
                [torch.zeros((self.batch_size, 16), dtype=torch.bool),
                 torch.ones((self.batch_size, 16), dtype=torch.bool)], dim=1
            )
        if input_name == "img_shapes":
            import torch
            return torch.tensor((1, self.height // 2, self.width // 2), dtype=torch.int64)
        return _qwen_original_generate(self, input_name, framework, int_dtype, float_dtype)
    _qwen_input_generator.generate = _qwen_generate
    _qwen_text_generator = _ov_configs.DummyQwenTextInputGenerator
    _qwen_text_generate = _qwen_text_generator.generate
    def _qwen_text_generate_compat(self, input_name, framework="pt", int_dtype="int64", float_dtype="fp32"):
        if input_name == "encoder_hidden_states_mask":
            import torch
            return torch.ones((self.batch_size, max(self.sequence_length, 16)), dtype=torch.bool)
        if input_name == "txt_seq_lens":
            import torch
            return torch.full((self.batch_size,), max(self.sequence_length, 16), dtype=torch.int64)
        return _qwen_text_generate(self, input_name, framework, int_dtype, float_dtype)
    _qwen_text_generator.generate = _qwen_text_generate_compat
    _qwen_config = _ov_configs.QwenTransformerOpenVINOConfig
    _qwen_inputs = _qwen_config.inputs.fget
    _qwen_config.inputs = property(lambda self: {**_qwen_inputs(self), "img_mask": {0: "batch_size", 1: "image_sequence_length"}})
    _original_qwen_export = _ov_convert.get_qwen_image_models_for_export
    def _qwen_export_compat(pipeline, exporter, int_dtype, float_dtype):
        config = pipeline.transformer.config
        was_frozen = getattr(config, "_FrozenDict__frozen", False)
        if "joint_attention_dim" not in config:
            config._FrozenDict__frozen = False
            config["joint_attention_dim"] = 4096
            config.joint_attention_dim = 4096
        config._FrozenDict__frozen = False
        try:
            text_config = getattr(pipeline.text_encoder.config, "text_config", None)
            if text_config is not None and "vocab_size" not in pipeline.text_encoder.config:
                vocab_size = getattr(text_config, "vocab_size", None)
                pipeline.text_encoder.config.vocab_size = vocab_size
            if text_config is not None:
                for _name in ("num_hidden_layers", "num_attention_heads", "num_key_value_heads", "hidden_size"):
                    if not hasattr(pipeline.text_encoder.config, _name) and hasattr(text_config, _name):
                        setattr(pipeline.text_encoder.config, _name, getattr(text_config, _name))
            return _original_qwen_export(pipeline, exporter, int_dtype, float_dtype)
        finally:
            config._FrozenDict__frozen = was_frozen
    _ov_convert.get_qwen_image_models_for_export = _qwen_export_compat
except Exception:
    pass
```

Save the following as `export-model.py` beside `export-compat.py`:

```python
"""Standalone export recipe reconstructed from the experiment report."""
import argparse, importlib.util, sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--model',required=True);p.add_argument('--output',required=True);p.add_argument('--turbo',action='store_true')
a=p.parse_args();out=Path(a.output)
if out.exists():p.error('Use a fresh export directory; existing exports are preserved.')
if a.turbo:
 sys.modules['torchaudio']=None
 import transformers.models.qwen2_vl.modeling_qwen2_vl as q2
 q2.VisionRotaryEmbedding=q2.Qwen2VLRotaryEmbedding
 import transformers.models.qwen3_vl.modeling_qwen3_vl as q3
 import transformers.models.qwen3_5.modeling_qwen3_5 as q35
 from transformers.vision_utils import get_vision_position_ids
 def positions(self,grid):
  return (get_vision_position_ids(grid,self.spatial_merge_size).unsqueeze(-1)*self.rotary_pos_emb.inv_freq).flatten(1)
 q3.Qwen3VLVisionModel.rot_pos_emb=positions;q35.Qwen3_5VisionModel.rot_pos_emb=positions
 spec=importlib.util.spec_from_file_location('fern_qwen_export_patches',Path(__file__).parent/'export-compat.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
from optimum.commands.optimum_cli import main
sys.argv=['optimum-cli','export','openvino','--model',a.model,'--task','text-to-image','--weight-format','int8','--library','diffusers',str(out)]
main()
(out/'.openvino_export_complete').write_text(f'model_id={a.model}\nweight_format=INT8\n',encoding='utf-8')
```

For regular, run the notebook-style export against `Qwen/Qwen-Image-2.1`:

```powershell
& ./runtime/Scripts/python.exe ./export-model.py --model Qwen/Qwen-Image-2.1 --output regular-int8
```

The original regular command did not pin `--revision`. The historical source cache contained revision `790c92633540aa0cb11d9abf19eb46d861714758`; for a controlled revisit verify that revision, download it as a local snapshot, and pass that local path instead. A completion marker proves the export command finished, not image quality.

For Turbo, recreate the historical separate overlay:

```powershell
py -3.12 -m venv --system-site-packages turbo-runtime
$regularSite = Join-Path $work 'runtime/Lib/site-packages'
$env:PYTHONPATH = $regularSite
& ./turbo-runtime/Scripts/python.exe -m pip install 'git+https://github.com/huggingface/diffusers.git@80c7ed262aeffbeb43ef13ae04baeb9b84515a69' 'transformers==5.17.0'
$env:PYTHONPATH = (Join-Path $work 'turbo-runtime/Lib/site-packages') + ';' + $regularSite
& ./turbo-runtime/Scripts/python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('WaveCut/Turbo-Image-2.1', revision='7dd5835ff53d226ad5715d3da8c720a5a9ed5c9b', local_dir='turbo-source')"
& ./turbo-runtime/Scripts/python.exe ./export-model.py --turbo --model turbo-source --output turbo-int8
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
```

This fetches the full source snapshot; the historical selected download contained 26 files. Fetch the source LICENSE/NOTICE and examine its distribution terms before choosing or publishing files. Export to a fresh directory; do not overwrite another working model.

### 3. Apply the recorded Turbo vision compatibility patch

GenAI required the `bilinear_indices` input to be i32. Save this as `patch-vision-encoder.py`:

```python
"""Export patched IR to a separate directory. Replace original pair only after validation."""
import argparse
from pathlib import Path
import openvino as ov
p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('output');a=p.parse_args()
output=Path(a.output)
if output.exists():p.error('Use a new output directory.')
m=ov.Core().read_model(a.source)
parameters=[v for v in m.get_parameters() if v.get_friendly_name()=='bilinear_indices']
if len(parameters)!=1 or parameters[0].get_element_type()!=ov.Type.i64:p.error('Expected one i64 bilinear_indices parameter.')
parameters[0].set_element_type(ov.Type.i32);m.validate_nodes_and_infer_types()
output.mkdir(parents=True);target=output/'openvino_model.xml';ov.save_model(m,target,compress_to_fp16=False)
check=ov.Core().read_model(target)
assert next(v for v in check.get_parameters() if v.get_friendly_name()=='bilinear_indices').get_element_type()==ov.Type.i32
print(target.resolve())
```

```powershell
& ./runtime/Scripts/python.exe ./patch-vision-encoder.py turbo-int8/vision_encoder/openvino_model.xml vision-patched
```

The helper emits and reloads a separate XML/BIN pair. After validation, back up the original pair and copy both patched files together into `turbo-int8/vision_encoder`. Never save over a loaded IR pair in place. If a new exporter already emits i32, investigate instead of forcing this patch.

### 4. Generate and inspect actual images

Save this as `sample-image.py`:

```python
"""Standalone historical OpenVINO sampling recipe, with separate load and inference timing."""
import argparse,json,time,hashlib
from pathlib import Path
import numpy as np
from PIL import Image
import openvino as ov
import openvino_genai as genai
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--output',required=True)
p.add_argument('--prompt',required=True);p.add_argument('--reference');p.add_argument('--device',default='GPU')
p.add_argument('--steps',type=int,default=8);p.add_argument('--seed',type=int,default=42)
p.add_argument('--width',type=int,default=512);p.add_argument('--height',type=int,default=512)
p.add_argument('--guidance',type=float,default=1.0);a=p.parse_args()
if a.width%32 or a.height%32:p.error('Dimensions must be divisible by 32.')
out=Path(a.output)
if out.exists():p.error('Output exists; use another filename.')
start=time.perf_counter();cls=genai.Image2ImagePipeline if a.reference else genai.Text2ImagePipeline
pipe=cls(a.model,a.device);load=time.perf_counter()-start;print(f'Loaded in {load:.1f}s',flush=True)
args=[a.prompt]
if a.reference:args.append(ov.Tensor(np.asarray(Image.open(a.reference).convert('RGB'),dtype=np.uint8)[None]))
start=time.perf_counter()
def progress(step,total,latent):print(f'Step {step+1}/{total}',flush=True);return False
result=pipe.generate(*args,width=a.width,height=a.height,num_inference_steps=a.steps,guidance_scale=a.guidance,generator=genai.TorchGenerator(a.seed),callback=progress)
data=np.asarray(result.data);data=data[0] if data.ndim==4 else data
if data.ndim==3 and data.shape[0] in (1,3,4) and data.shape[-1] not in (3,4):data=np.moveaxis(data,0,-1)
if not np.isfinite(data).all():raise RuntimeError('Nonfinite pixels')
if data.dtype!=np.uint8:
 if np.issubdtype(data.dtype,np.floating) and data.min()>=0 and data.max()<=1:data=data*255
 data=np.clip(data,0,255).astype(np.uint8)
if float(data.std())<0.5:raise RuntimeError('Flat output rejected')
out.parent.mkdir(parents=True,exist_ok=True);Image.fromarray(data).convert('RGB').save(out)
record={**vars(a),'load_seconds':load,'inference_seconds':time.perf_counter()-start,'std':float(data.std()),'shape':list(data.shape),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'custom_sigmas_applied':False}
out.with_suffix('.json').write_text(json.dumps(record,indent=2));print(json.dumps(record,indent=2))
```

```powershell
& ./runtime/Scripts/python.exe -c "import openvino as ov; print(ov.Core().available_devices)"
& ./runtime/Scripts/python.exe ./sample-image.py --model regular-int8 --device GPU --steps 8 --seed 9252026 --prompt 'A photorealistic red apple on a wooden table, natural light' --output results/regular.png
& ./runtime/Scripts/python.exe ./sample-image.py --model regular-int8 --device GPU --steps 8 --seed 9252028 --reference results/regular.png --prompt 'Change the apple into a green pear, preserve the table and lighting' --output results/regular-edit.png
& ./runtime/Scripts/python.exe ./sample-image.py --model turbo-int8 --device GPU --steps 6 --seed 42 --guidance 1 --prompt 'A photorealistic red apple on a wooden table, natural light' --output results/turbo.png
& ./runtime/Scripts/python.exe ./sample-image.py --model turbo-int8 --device GPU --steps 6 --seed 43 --guidance 1 --reference results/turbo.png --prompt 'Change the apple into a green pear, preserve the table and lighting' --output results/turbo-edit.png
```

The prompts are a reusable test pair, not a claim to recover every historical sample's exact prompt. This reproduces the OpenVINO approximation: custom Turbo sigmas remain unapplied. The helper records separate load/inference time, output shape, seed, hash, and pixel standard deviation and rejects uniform output. Visually evaluate prompt adherence and editing fidelity; a non-flat image alone is insufficient. Record hardware/driver, RAM, GPU memory, and free disk. Benchmark several cold and warm runs separately.

### 5. Reconsider integration only after the practical gates pass

Establish acceptable GPU latency and visual quality for text and editing on target hardware. Compare step sweeps and several seeds/prompts. For Turbo, implement exact custom-sigma support or validate and document an intentional alternative. Keep regular/Turbo identities separate. Verify production image sizes, requested edit dimensions, cancellation, repeated requests, and bounded caches. Recheck licensing.

Only after those gates, implement a new adapter around GenAI `Text2ImagePipeline`/`Image2ImagePipeline` in a new development branch. If using a persistent worker, keep a tagged event protocol such as `FERN_QWEN_EVENT:`, parse only tagged events, read worker output independently, and terminate the worker on cancellation. Add catalog/API validation, bundling and model-specific controls, then verify actual native Electron text generation/editing. Revalidate AUTO/NVIDIA separately if advertised. No old adapter code is retained or restored by this report.

## Retirement record

Removed the selectable catalog entry, UI labels/menu/card/preset, API/backend dispatch, isolated image worker, active exporter patches/install recipe, and image-specific resource-bundle entries. Unsupported saved model IDs migrate to Auto with four steps, guidance 1, and dimensions clamped to valid Flux bounds. Prompts, thread IDs, references, and existing image histories remain. Remixing historical outputs also uses this migration.

The original model deletion covered six source/export directories (`models/qwen-image-2.1`, `qwen-image-2.1-notebook`, `qwen-image-2.1-notebook-int8-retry`, `qwen-image-2.1-ov`, `qwen-image-2.1-turbo-openvino-int8`, and `qwen-image-2.1-turbo-source`), both `.cache/openvino/qwen-image-2.1` and `qwen-image-2.1-turbo`, `.cache/huggingface/hub/models--Qwen--Qwen-Image-2.1`, and `tmp/qwen-turbo-vision-encoder-patch`. Their combined logical size was **111.327 GiB**, not a guaranteed disk-free delta. All ten targets were verified absent. The default user Hub cache contained no named Qwen Image 2.1/Turbo cache directory.

Historical retirement validation passed TypeScript checks, the desktop production build, 46 Python tests, and native Electron checks for catalog/model-library removal, retired-generation rejection, saved-thread migration, and the retained audio workspace. No new export or image generation was run during retirement.

On 2026-10-03 the owner clarified that only this report should remain. The incorrectly retained archive (notebook, samples, old adapters, helpers, requirements and manifests), standalone notebook checkout, and image-experiment scratch/evidence files were removed. Necessary recreation details were consolidated into this document. Qwen3-TTS and Flux remain separate active features. Generic rejection/migration of unsupported saved image-model IDs remains app compatibility behavior, not a retained Qwen Image implementation.
