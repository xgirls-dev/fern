# Chroma-1 OpenVINO experiment — final assessment

**Status: stopped.** Chroma-1 HD and Chroma-1 Flash are removed from Fern's active model families and inference/packaging code. Neither variant met Fern's practical generation-speed requirement on the Intel GPU used for testing. The final Flash run produced a recognizable image, but a good result that takes several minutes is still not useful for Fern's intended workflow.

This record consolidates the local export and Electron tests. All generation runs described below used the Intel GPU; no image generation was run on CPU. The existing downloaded exports and generated images were left on disk and were not downloaded again or deleted as part of this code cleanup.

## Test setup

- Prompt: `A red fox sitting in a sunflower field, cinematic light`
- Canvas: 256 × 256, batch size 1
- Seed: `1365493171`
- Device: Intel GPU through OpenVINO
- Fern tests: source Electron app and installed Electron builds, using the local exports
- Reference: the user supplied a 256 × 256 Chroma-1 HD result from the [Hugging Face ImageGen Space](https://huggingface.co/spaces/RioShiina/ImageGen)

## Results

| Variant / run | Settings | Output and timing | Assessment |
| --- | --- | --- | --- |
| Chroma-1 HD, source Electron | 30 steps, guidance 4 | Coherent fox image. Generation: **630.9 s (10m31s)**; first pipeline load about **4m07s**; denoising averaged about **17–21 s/step**. | Image quality was promising and close to the hosted reference. Far too slow. |
| Chroma-1 HD, installed Fern 0.1.37 | 30 steps, guidance 4 | Coherent matching image. Render Info: **11m17s**. | Confirms the packaged path worked; speed remained impractical. |
| Chroma-1 Flash, installed Fern 0.1.38 | 8 steps, guidance 1 | Recognizable image with strong rectangular seams. First pipeline load about **4m03s**; Render Info **3m58s**; queue-to-complete about **8m02s**. | Initial scheduler configuration and excess transformer evaluations were wrong; required troubleshooting. |
| Chroma-1 Flash, installed Fern 0.1.40 | 8 steps, guidance 1 | Output severely corrupted with vertical bands and blocks. API reported **556.2 s** generation; pipeline readiness **6m48s**; queue-to-complete about **16m07s**. | Not a usable result. The transformer received all 512 padded T5 positions despite having no attention-mask input. |
| Chroma-1 Flash, installed Fern 0.1.41 | 8 steps, guidance 1 | Coherent, recognizable fox. API reported **266.5 s** generation; pipeline readiness **5m13s**; queue-to-complete about **9m40s**. | The correctness fix removed the severe corruption and roughly halved reported generation time, but still took several minutes for a 256px image. Not practical. |

## What was tried and what failed

1. **Dedicated Chroma OpenVINO pipeline.** Chroma has its own Diffusers pipeline and transformer, so it could not simply be loaded as a FLUX.1 Dev model. Fern used a dedicated adapter around exported OpenVINO components.
2. **Chroma-1 HD export.** The transformer weights were compressed with NNCF `INT8_SYM`; the local directory name containing `int4` did not reflect the actual quantization. Transformer, T5, and VAE inference used FP32 precision in the successful reference run. Output quality was acceptable, but the 10–11 minute render time ruled it out.
3. **Chroma-1 Flash scheduler.** The first integration reused the HD scheduler configuration and Heun sampling. That caused 15 transformer evaluations for 8 visible steps. It was corrected to use the Flash repository's `FlowMatchEulerDiscreteScheduler` configuration and one transformer evaluation per step.
4. **T5 prompt-length handling.** The exported T5 graph has a fixed 512-token input. Attempting to feed only the unpadded prompt length failed because the traced graph contains a fixed reshape. Keeping the 512-token T5 input and cropping the output embeddings was required.
5. **Padding semantics and corrupted Flash output.** The exported transformer has no attention-mask input. Passing all 512 T5 embeddings made padded positions visible to the transformer and yielded severe bands/blocks. The fix kept the T5 input at 512 tokens, then cropped embeddings to the prompt plus one padding token before transformer inference. This follows the [Diffusers Chroma API requirement](https://huggingface.co/docs/diffusers/api/pipelines/chroma) that a single padding token remain unmasked.
6. **Corrected final Flash run.** The crop fixed the obvious image corruption, but the 8-step generation still required 266.5 seconds after the pipeline was loaded, and the full user-visible operation took about 9m40s. The denoising timeline also had two unusually long step intervals (about 36–38 seconds), in addition to typical 5–6 second intervals.

## Decision

Both Chroma choices are retired from Fern for now. HD can produce good images but takes roughly ten minutes; Flash can produce a coherent image after the scheduler and padding fixes, but it remains orders of magnitude too slow for practical interactive use on this machine. The observed Flash corruption was an integration bug and was fixed; it is not the reason for stopping. The deciding issue is speed after a usable image is obtained.

No claim is made that Chroma itself is inherently this slow on every runtime or accelerator. This conclusion is specifically about Fern's tested OpenVINO exports and Intel-GPU execution path. Reconsider only if a substantially faster export/runtime path or hardware target is available and measured before reintegration.
