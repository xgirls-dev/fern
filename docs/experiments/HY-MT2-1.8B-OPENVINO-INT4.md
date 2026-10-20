# Tencent Hy-MT2-1.8B OpenVINO INT4 export

Recorded 2026-10-14. Status: successful local experiment. The source model is `tencent/Hy-MT2-1.8B`; the local OpenVINO INT4 export is not published to Hugging Face and is not registered as an installable Fern model.

## Why this model

The official OpenVINO notebooks repository includes a Hy-MT2 translation notebook with an INT4 Optimum export recipe. The OpenVINO GenAI supported-models list includes `tencent/Hy-MT2-1.8B` under `HunYuanDenseV1ForCausalLM`. The upstream model card labels the model Apache-2.0. These establish a plausible OpenVINO candidate and source license; they do not establish the quality or licensing of a future redistributed quant without reviewing all source files/notices at release time.

References: [OpenVINO HunYuan translation notebook](https://github.com/openvinotoolkit/openvino_notebooks/blob/latest/notebooks/hunyuan-translation/hunyuan-translation.ipynb), [OpenVINO GenAI supported models](https://openvinotoolkit.github.io/openvino.genai/docs/supported-models/), and [Tencent model card](https://huggingface.co/tencent/Hy-MT2-1.8B).

## Export recipe

The export used Fern's existing `.venv-release` environment and kept all model files in the git-ignored `models/` directory. The source revision cached for this run was `9a341cd1b679d3efd23b46e847b01745a71ed792`.

```powershell
.venv-release\Scripts\optimum-cli.exe export openvino `
  --model tencent/Hy-MT2-1.8B `
  --task text-generation-with-past `
  --weight-format int4 `
  --group-size 128 `
  --ratio 0.8 `
  --cache_dir .cache/hy-mt2-export `
  models/hy-mt2-1.8b-int4-openvino
```

The exporter applied INT4 asymmetric weights, group size 128, to 80% of ratio-defining parameter layers, and INT8 asymmetric per-channel weights to the remaining 20%. The OpenVINO IR was approximately 1.12 GiB (`openvino_model.bin` 1,199,338,531 bytes; XML 3,411,409 bytes).

The CLI export did not include the GenAI tokenizer and detokenizer IR. This follow-up completed those assets with the same cached source tokenizer:

```python
from optimum.exporters.openvino.convert import export_tokenizer
from transformers import AutoTokenizer

output_dir = "models/hy-mt2-1.8b-int4-openvino"
tokenizer = AutoTokenizer.from_pretrained(
    "tencent/Hy-MT2-1.8B", cache_dir=".cache/hy-mt2-export"
)
tokenizer.save_pretrained(output_dir)
export_tokenizer(tokenizer, output_dir, task="text-generation-with-past")
```

The resulting folder contains model and tokenizer/detokenizer XML/BIN files, tokenizer config/JSON, model config, generation config, and chat template. The full source model cache remains separate from the export folder.

## Validation

- Fern's `scripts/text_model_registry.py` `inspect_model(..., validate_ir=True)` accepted the exported folder as `HunYuanDenseV1ForCausalLM` / `hunyuan_v1_dense`.
- OpenVINO enumerated CPU and GPU devices. Direct `openvino_genai.LLMPipeline` inference on GPU produced translations in both English-to-Chinese and Chinese-to-English directions.
- Fern's existing `TextGenerationProcess` and `scripts/text_generation_worker.py` loaded the exported folder on `GPU`, applied the conversation template, streamed a response, and completed successfully. Translation request: “OpenVINO is a toolkit for optimizing and deploying deep learning models.” Result: “OpenVINO是一个工具包，用于优化和部署深度学习模型。” The worker reported 28 input tokens, 15 output tokens, 2.58 seconds generation time, and 5.82 tokens/second for this single warm generation. This is a smoke check, not a benchmark.

Environment versions: OpenVINO `2026.4.1`, OpenVINO GenAI `2026.4.1.0`, OpenVINO Tokenizers `2026.4.1.0`, Optimum Intel `1.27.0.dev0+7234214`, Transformers `5.0.0`, and NNCF `3.4.0`. Export emitted a warning that multiple `optimum` distributions were present and selected `optimum`; the resulting IR loaded and ran through Fern's worker successfully.

## Translation quality and speed evaluation

The broad comparison used the public [Helsinki-NLP/opus-100](https://huggingface.co/datasets/Helsinki-NLP/opus-100) held-out test splits at dataset revision `805090dc28bf78897da9641cdf08b61287580df9`. It sampled 50 evenly spaced parallel rows from each of 32 available English-centric language configurations and evaluated both translation directions: 3,200 prompts across 64 directions per export. The upstream model card lists 36 languages, so this is broad coverage but not full language or direction coverage. It does not measure non-English-to-non-English translation.

An attempted FLORES+ evaluation was blocked by the dataset's Hugging Face access gate (HTTP 403 for this account). No gated-data access was bypassed. OPUS-100's dataset card marks its license as unknown, so source sentences, references, and per-example model outputs stay in the ignored local `.cache/hy-mt2-evaluation/` directory and are not included in this repository report.

Both exports received the model card's default English translation instruction, with the target language name written in full and the user's text wrapped in the source model's chat template. Decoding was greedy (`do_sample=False`, temperature `0`, seed `42`, `top_p=0.6`) with a 256-token output cap. We report SacreBLEU chrF++ macro-average over the 64 directions. BLEU uses SacreBLEU `13a` and is macro-averaged only over the 26 directions whose targets are not Chinese, Japanese, Korean, Khmer, Burmese, or Thai; this avoids applying its whitespace tokenization to those scripts. Speed is aggregate generated model tokens divided by corpus inference time on this machine's Intel GPU, after a separate warmup; it is not an end-user latency guarantee.

| Measure | INT4 | FP16 reference |
|---|---:|---:|
| Export folder size | 1.22 GB | 3.60 GB |
| Prompts / directions | 3,200 / 64 | 3,200 / 64 |
| Macro chrF++ | 33.16 | 35.17 |
| Macro BLEU 13a (26 space-tokenized directions) | 13.91 | 15.31 |
| Aggregate generated tokens / second | 14.88 | 11.27 |
| Empty outputs | 0 | 0 |
| Exact source echoes | 112 | 90 |
| Outputs at or near 256-token cap | 17 | 14 |

INT4 is about 2.96 times smaller and 1.32 times faster on this particular run. Its broad-sample macro scores are lower by 2.01 chrF++ points and 1.41 BLEU points. Exact source echoes and near-cap outputs are diagnostic counts, not automatic failures; source echoes were mostly short literals in a manual spot check. The benchmark has no formal human rating or task-specific adequacy scoring; the small manual review is qualitative only.

The paired broad-sample direction comparison found INT4 more than one chrF++ point below FP16 in 39 of 64 directions, within one point in 22, and above FP16 by more than one point in 3. The largest observed drops were English-to-Uyghur (-12.33), Gujarati-to-English (-7.76), Marathi-to-English (-7.25), and English-to-Gujarati (-6.28). Since each direction initially has only 50 examples, these were treated as signals for confirmation rather than precise estimates.

A disjoint confirmation set added 50 more parallel rows for Uyghur, Gujarati, Marathi, Telugu, German, and Spanish. Both exports were scored on the same 600 prompts, combined with the original sample to yield 100 examples in each of 12 directions. On the add-on set alone, macro chrF++ was 35.88 for INT4 and 40.56 for FP16. Across the combined 100-example focused sample, it was 35.02 vs 39.45 (INT4 minus FP16: -4.42 points); 11 of 12 directions were more than one point lower, and none were more than one point higher.

An initial attempt used 150 new pairs per language, but the FP16 run took about 1,000 seconds for its first 200 prompts. That partial run was stopped; its predictions are excluded. The final confirmatory metrics below use only the matched 50-new-pair set.

| Focused direction (100 examples each) | INT4 chrF++ | FP16 chrF++ | Difference |
|---|---:|---:|---:|
| English → Uyghur | 3.20 | 14.26 | -11.06 |
| Gujarati → English | 37.46 | 45.81 | -8.35 |
| Marathi → English | 47.68 | 53.49 | -5.81 |
| English → Telugu | 24.13 | 29.65 | -5.53 |
| English → Gujarati | 29.62 | 34.95 | -5.32 |
| English → Marathi | 41.76 | 45.71 | -3.94 |
| Telugu → English | 23.13 | 27.50 | -4.37 |
| English → German | 41.45 | 44.70 | -3.25 |
| German → English | 49.27 | 50.59 | -1.33 |
| English → Spanish | 53.05 | 54.86 | -1.80 |
| Spanish → English | 54.42 | 55.13 | -0.70 |
| Uyghur → English | 15.12 | 16.73 | -1.61 |

The selected set intentionally over-represents weak directions, so its macro score is not an estimate of overall multilingual performance. It confirms that the large gaps persist on fresh examples, and shows that degradation also appears in German and Spanish controls. A manual side-by-side spot check found INT4 sometimes answering an English-to-Uyghur request in Chinese where FP16 answered in Uyghur; both exports also made errors. The OPUS-100 references include noisy, incomplete, or misaligned rows, so automatic scores are imperfect proxies for adequacy. This evaluation has no independent human raters and does not establish quality for every language/domain.

The broad INT4 run used batch size 4. The FP16 run used batch size 4 for its first 392 prompts and batch size 8 for the remaining prompts after a controlled resume; the batch change did not show a throughput advantage. Both scored all 3,200 aligned examples. The focused 600-prompt runs used batch size 4 for FP16 and batch size 8 for INT4, so their speeds are not a controlled comparison. The broad run is the only speed comparison; it remains a local model-size/performance signal, not a hardware-independent claim.

## Scope and next decision

This establishes that the source model can be exported and that its INT4 OpenVINO artifacts run through the existing local text worker on this machine's Intel GPU. The quality tradeoff is too large for recommending this export as a general-purpose multilingual quant: the broad sample regressed, and the independent focused sample confirmed substantial losses in the weakest directions. Do not publish this INT4 configuration as the default 36-language model. A future quantization attempt should compare less aggressive or selective quantization against the same aligned evaluation before reconsidering. This does not establish translation quality across all 36 languages, performance on other hardware, packaging/download integration, or redistribution readiness. No app model catalog was changed and no Hugging Face upload was made. The export remains a local experiment at `models/hy-mt2-1.8b-int4-openvino`.
