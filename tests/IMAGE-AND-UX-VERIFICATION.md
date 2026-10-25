# Image generation and navigation fixes — 2026-10-24

## Pony failures

The dedicated Pony adapter derived its root from `__file__`, while the API and
Klein adapter use `FERN_ROOT` / `INTEL_IRIS_ROOT`. In an installed app the scripts
live under `resources`, and generation is staged under the writable profile.
The adapter therefore rejected valid generation paths before loading the model.
Pony now shares Klein's resolved workspace and model-storage roots.

A real Intel GPU test imported the adapter from
`apps/desktop/resources/scripts`, supplied a different writable root, and saved
a PNG. Visual inspection then exposed the separate noisy-output problem in
[issue #4](https://github.com/xgirls-dev/fern/issues/4).

The pinned Pony exports label their scheduler as
`EDMDPMSolverMultistepScheduler`. That scheduler uses EDM preconditioning and
log-sigma timesteps, which do not match this standard SDXL epsilon denoiser.
The dedicated adapter now corrects the runtime scheduler to DPM++ 2M Karras,
using the SDXL beta schedule. Known Pony exports registered as custom SDXL
models receive the same compatibility correction. Downloaded artifacts are
kept intact.

Evidence:

- Regular Pony, old scheduler, 512×512, 4 steps: valid PNG containing noise.
- Same prompt/seed after correction: a structured scene rather than noise.
- Pony INT8, bundled adapter, Intel GPU, 512×512, 30 steps, guidance 7,
  seed 452913967: completed and produced a coherent photograph. Inference and
  decoding took 237.4 seconds, excluding model loading.
- Image: `artifacts/ux-verification/pony-int8-dpm-30steps.png`.

Issue #4's exact prompt and parameters (1024×1024, 30 steps, guidance 7,
seed 994286815, Intel GPU, no reference image) completed on the installed
0.1.30 candidate with both the INT8 and FP16 cards. Both reached step 30 and
returned generated images; the issue's pure-noise result was not reproduced.
The INT8 result matched the earlier local-build result byte for byte. The
installed-release outputs are retained under `artifacts/release-test/`.
GitHub issue #4 was closed on 2026-10-25 after the installed 0.1.30 checks
completed without reproducing the reported pure-noise output.

The earlier 30-step quality check used 512×512. The exact 1024×1024 issue case
was also completed in the installed 0.1.30 candidate as described above.

## Multiple reference images

[Issue #3](https://github.com/xgirls-dev/fern/issues/3) is implemented for Klein
4B and 9B through the existing Optimum/OpenVINO adapter. Its inherited
`Flux2KleinPipeline` accepts a list of reference images.

- Up to four PNG/JPEG/WebP attachments, with independent size validation.
- File selection, drop, paste, reordering, individual removal, and numbered
  prompt references.
- Attachments live in IndexedDB, with migration from the previous single-image
  value. Their thread identity and labels are persisted alongside them.
- The API accepts `reference_images` and keeps the old `reference_image` input
  compatible. It enforces family and attachment-count limits before generation.
- Ordered reference URLs are saved in gallery metadata and restored for variations.
- Switching to an incompatible model retains attachments and blocks generation
  with an actionable message.

A real Klein 9B Intel GPU run supplied two separate 128×128 reference images,
generated a valid 256×256 PNG at two steps, and completed in 102.5 seconds
excluding model loading. It used the complete model in the existing legacy
profile. The newer Fern profile's Klein folder was incomplete. No installed
model files were changed. Four-input inference and a separate 4B GPU run were
not performed; the API/UI limits, ordering, persistence, and shared adapter
dispatch are covered by regression checks.

## Navigation and model management

- Models has a full main view with Image, Text, and Audio categories, plus direct
  entries in the sidebar, image/text model menus, and command palette.
- Preferences contains general application settings.
- One New thread menu provides Image, Text, and Audio creation.
- Thread categories use a shared scroll container. Top navigation and bottom
  application controls stay reachable.
- Image and text model menus keep every option on one line; long names truncate
  and expose their full text in a tooltip.
- Model cards have short summaries and expandable technical details. Existing
  download, pause, cancel, repair, removal, and source-preservation behavior is retained.

## Verification

### Installed-release compute and render-info check

- The 0.1.31 build was installed over 0.1.30 through the Windows installer.
  Existing threads and image models persisted; no model was redownloaded.
- Klein 4B generated one 768×768, 4-step smoke image in the installed app.
  Activity recorded OpenVINO `GPU`, and Render info recorded `Intel GPU`; the
  image was saved locally in 103.2 seconds.
- In Electron, the default compute preference kept the CPU toggle off, hid CPU
  from device selection, and reported the available Intel GPU. Enabling the
  preference exposed CPU explicitly; disabling it hid the choice and returned
  the selection to GPU. The composer had no separate device selector.
- The 0.1.32 installer was built and installed over 0.1.31. The existing
  480-second render metadata now displays `8m` instead of `7m 60s`. The
  installed Preferences view still hid CPU by default and detected Intel GPU
  with OpenVINO SDXL.
- Installer: `Fern-Setup-0.1.32.exe` (475,476,921 bytes), SHA-256
  `8A17B20BE57F2A4F27E387B94B9071F966FD406683834FD4A3252E1B2C21AA31`.
- TypeScript typecheck passed. The targeted Playwright UI run could not start
  because this Windows profile lacks Playwright's Chromium executable; the
  rounding fix was verified in the packaged Electron app instead.

### Installed-release custom OpenVINO model check

- In the installed 0.1.32 app, the existing Klein 4B OpenVINO folder was linked
  through Models → Add custom model as a local FLUX.2 Klein export. The folder
  was absent from the catalog before linking; Fern registered it without
  downloading or copying model files.
- The linked model appeared in Model Library and in the image-thread model
  selector. A 768×768, 4-step image request was submitted with the app reporting
  the available Intel GPU; the activity log confirmed it queued on Intel GPU
  and loaded the custom export on GPU.
- Inference failed before producing an image. OpenVINO GenAI reported:
  `VAE config missing required 'bn_running_mean_data' and/or
  'bn_running_var_data' for Flux2KleinPipeline`.
- This verifies local-folder registration and GPU dispatch, but not successful
  generation for the local export. The four export folders named in GitHub
  issue #1 were not present on this PC, so those exact exports remain untested.
- Follow-up on the installed 0.1.32 app: linked the existing
  `flux2-klein-9b-circulus-int4` folder in place, with no download or copy. The
  import form initially defaults to SDXL and rejected the export's
  `Flux2KleinPipeline` until FLUX.2 Klein was selected. After registration it
  appeared in the thread model menu. A 1024×1024, 4-step request queued on
  Intel GPU and failed at VAE setup with the same missing
  `bn_running_mean_data` / `bn_running_var_data` error, before producing an
  image. This confirms the installed catalog's 9B export has the same custom
  pipeline limitation as the existing 4B test; the issue reporter's four
  exact folders remain unavailable here.

### Installed-release Klein 9B download

- Started the Klein 9B download from the Models view in installed Fern 0.1.32.
- The temporary download directory was finalized as
  `flux2-klein-9b-circulus-int4`. All 27 catalog files are present; payload size
  is 9,624,762,536 bytes. The `model_index.json` identifies
  `Flux2KleinPipeline` from `kp-forks/FLUX.2-klein-9B`.
- C: had about 145.5 GB free before the download and 136.5 GB afterward. The
  9B model is kept for later testing because it is below the large-model cleanup
  threshold.
- The installed Electron app reported `Installed · OpenVINO runtime ready`.
  Klein 9B generated a 768×768 image at 4 steps, guidance 1, seed 994286815.
  Activity logged `Adapter: Intel GPU` and `OpenVINO device: GPU`; Render info
  reported `Intel GPU` and model `Klein 9B`. Inference took 191.1 seconds after
  the first model load. All four steps completed and the PNG was saved as
  `flux2-klein-9b-20261024-234840-seed994286815.png`.

### Installed-release Qwen Image 2.1 Turbo install and GPU generation

- In the installed 0.1.32 Electron app, started Qwen Image 2.1 Turbo · official
  from Models. The first model transfer ended with a size mismatch on
  `transformer/openvino_model.bin` (downloaded 6,721,762,297 bytes vs the pinned
  catalog's 7,119,610,744 bytes). Retry resumed and completed the partial file;
  previously completed files were retained and validated rather than fetched
  again. The full 23.20 GB payload passed the installer’s size and SHA-256
  checks, then the isolated OpenVINO dependencies installed and the card showed
  `Installed · OpenVINO runtime ready`.
- The actual composer exposed Qwen only after install. Its settings showed
  768×768, one image, fixed 8 steps, guidance 1.0, and “Fern will use the
  available Intel GPU.” Preferences confirmed `Allow CPU selection` off and
  Intel GPU ready, NVIDIA unavailable.
- Generated `A red cube on a plain gray background.` in the new image thread.
  Activity recorded the request queued on Intel GPU and all eight steps,
  followed by `Batch complete | 1 image(s)`. Render info reported 768×768,
  Qwen Image 2.1 Turbo · official, Intel GPU, 8 steps, guidance 1, and 9m 3s.
  The separate first-run compile/load made the overall UI run 14m 26s. The
  runtime also logged nonfatal missing-`scaling_factor` warnings for the VAE
  encoder and decoder. The preview was nonblank and saved as
  `C:\Users\codex\AppData\Roaming\Fern\studio-data\outputs\qwen21-turbo-1792906942500-1.png`
  (582,245 bytes).
- The model and its first-run OpenVINO cache are retained for reuse. C: had
  114.8 GB free before this turn’s Qwen install and 78.4 GB after the model,
  dependencies, and first-run cache. No app rebuild or reinstall was needed.
- Follow-up UI check in installed 0.1.32 Preferences: with `Allow CPU
  selection` off, the generation-device selector is absent and the runtime
  reports Intel GPU. Enabling the opt-in reveals a selector with `Available
  GPU` still selected and `CPU` as an explicit option; disabling it hides the
  selector again. Intel GPU remained Ready throughout. CPU generation was not
  selected or run.
- The image settings panel shows `Fern will use the available Intel GPU` and
  has no per-render device selector. The image run recorded above also confirms
  that this default dispatched to Intel GPU.
- Source verification rerun on 2026-10-25 after the current worktree changes:
  `npm run check` passed TypeScript, Python compilation, all 92 Python tests,
  and the production build. The renderer regression suite passed all 12/12
  scenarios. Both commands needed permission to start child processes because
  the restricted workspace sandbox returned `EPERM` for esbuild, Chrome, and
  Python multiprocessing; the unsandboxed rerun passed.
- `npm run test:electron --workspace @fern/desktop` also passed after rebuilding
  the source app. It exercised the real Electron main/preload/API bridge,
  multi-reference persistence through three reloads, Models navigation and
  family/repository controls, local-folder registration/removal via the native
  dialog IPC, cancellation, composer model selection, and source-file
  preservation. Test data used an isolated temporary profile and was cleaned.
- GitHub Releases checked in the browser on 2026-10-25 still marks v0.1.29 as
  `Latest`; the locally installed 0.1.32 candidate is not listed as a published
  release. No stale installer was installed during this follow-up.

### Local-build Klein 9B Electron check

- Launched the current source build through `npm run start` and the real Fern
  Electron window. The first attempt used the per-user data folder as the
  development root and left the backend disconnected; restarting with the
  repository root fixed the Python API startup. The local backend reported
  healthy and returned the model catalog.
- Reused the existing Klein 9B download through a temporary NTFS junction in
  the repository model directory. No model files were downloaded or copied.
- The local Models view showed Klein 9B as `Installed · OpenVINO runtime ready`.
  Preferences showed GPU as the default, CPU hidden and disabled, Intel GPU
  ready, and NVIDIA unavailable. Image settings said Fern would use the
  available Intel GPU; the composer had no separate device selector.
- In the local Electron UI, Klein 9B generated one 768×768 image at 4 steps,
  guidance 1, seed 994286815. Activity recorded `Adapter: Intel GPU` and
  `OpenVINO device: GPU`; Render info recorded device `Intel GPU`, model
  `Klein 9B`, and 3m 7s. All four steps completed in 186.5 seconds, and the
  PNG was saved as
  `flux2-klein-9b-20261025-000627-seed994286815.png`.
- Reverification on 2026-10-25: `npm run check` passed with `.venv\Scripts`
  first in `PATH` (TypeScript, Python compilation, 92 Python tests, and the
  production build). The bare command selected global Python and lacked
  `defusedxml`. `npm run test:ui` passed all 12 renderer scenarios using the
  installed Chrome; its 479.5-second fixture is initialized before the page
  loads so the `8m` assertion is deterministic.

- `npm run check`: TypeScript, Python compilation, 92 Python tests, production build.
- Renderer regression suite: all 12 scenarios passed after correcting two stale
  locator assumptions. This includes model menus, model installation controls,
  reference lifecycle, text streaming/retry/reload, viewer actions, deletion,
  responsive layouts, and scale fixtures with up to 1,000 images / 500 threads.
- New regression coverage includes the configured Pony workspace, legacy sampler
  correction, reference ordering/family limits, and custom GenAI pipeline reuse.
- Electron smoke uses a hidden isolated profile, the actual main/preload/API
  bridge, real IndexedDB persistence, and mocked native folder-picker results.
- The 0.1.30 packaged executable also passed those workflow assertions using
  its extracted bundled Python runtime and a fresh profile, with `app.isPackaged`
  verified. Its backend payload matches the source and passes the 59-file audit.
- Immediate repeated reloads exercise attachment persistence: the UI exposes
  attachments after their IndexedDB transaction completes, and saves the owning
  thread synchronously before that write.
- The final packaged smoke completed with exit code 0, including three immediate
  attachment reloads and temporary-runtime cleanup.
- Final installer: `Fern-Setup-0.1.30.exe`, 473,193,257 bytes; SHA-256
  `E0837445016C7C72BA0588A9B9A5565E06AD25E24DFD44CF25AD2ECA1E8288A7`.

Run `npm run test:ui` for renderer checks and
`npm run test:electron --workspace @fern/desktop` for Electron integration.
Both regular CI and the release workflow now run the renderer regression suite;
the release workflow also runs the hidden Electron integration check and tests
the packaged executable after building, before publishing.
The model inference checks require an Intel GPU and installed exports; they
are separate from CI's fixture-based tests.

### Installed-release custom FLUX.2 Klein check

- After the local custom Klein 9B export failed under OpenVINO GenAI with the
  missing VAE batch-normalization stats error, the custom pipeline was routed
  through the existing Optimum Intel `OVFlux2KleinPipeline` adapter used by
  Fern's built-in Klein path. The existing GenAI adapter remains in use for
  other custom families.
- Rebuilt and installed the local 0.1.32 candidate over the existing 0.1.32
  installation after this backend code change. The existing 9B export remained
  in place; no model download or weight cleanup was performed.
- In the installed Electron UI, selected the registered
  `flux2-klein-9b-circulus-int4` custom entry, entered the minimal red-cube
  prompt, and generated at 1024×1024, 4 steps, guidance 1. Activity recorded
  `Loading ... on GPU`, then `OpenVINO image pipeline is ready`, all four steps,
  and `Batch complete | 1 image(s)`. The saved output reports `device:
  INTEL_GPU` and inference time 355.7 seconds after the 83-second initial model
  load (7m21s from queued to complete). Pixel statistics confirm a
  nonblank image (RGB standard deviation 51.76; 3,122 sampled unique colors).
- `npm run check` passed after the adapter change: TypeScript, Python
  compilation, all 93 Python tests, and the production build. A focused test
  verifies the custom Klein family invokes Optimum Intel; a separate fixture
  continues to verify OpenVINO GenAI custom-family loading. The Windows
  computer-use helper timed out during the final wait, so completion was
  confirmed from Fern's read-only local job status and saved output after the
  run had been started and monitored in the Electron UI.
- `npm run test:electron --workspace @fern/desktop` passed after rebuilding the
  source app. The isolated smoke verified the preload/API bridge, model
  controls, local-folder registration/removal, cancellation, and preservation
  of source model files.
- Output: `custom-image-1792910209879-1.png` under the Fern studio-data outputs
  folder. Follow-up provenance check for GitHub issue #1 found the public
  [`circulus/FLUX.2-klein-9B-ov-int4`](https://huggingface.co/circulus/FLUX.2-klein-9B-ov-int4)
  export. Its `model_index.json` uses `Flux2KleinPipeline` and
  `kp-forks/FLUX.2-klein-9B`; the existing local
  `flux2-klein-9b-circulus-int4` folder has the same model index and 27 model
  files totaling 9,624,762,465 bytes (plus Fern's 71-byte local marker). The
  Hugging Face page reports 27 files totaling 9.62 GB. This strongly indicates
  that the successful GPU test covers the issue's first FLUX.2 Klein export.
  Full per-file hash comparison has not been performed. The other three exact
  exports were not located and remain unverified.

### Installed-release Qwen3 4B text download and GPU response

- In installed Fern 0.1.32, opened Models → Text and downloaded the recommended
  Qwen3 4B Instruct 2507 OpenVINO export through the app. Fern verified
  `generation_config.json`, converted the tokenizer and detokenizer, and showed
  the model as Installed. Its pinned main weight is 4,026,830,485 bytes; the
  model remains installed because it is a moderate-sized download.
- Created a new text thread in Electron. Qwen3 was selected by default and the
  chat settings exposed its regular model-generation controls.
- Sent `Reply with exactly: Qwen3 local GPU smoke test passed.` The completed
  response matched exactly. Response details reported GPU, 21 input tokens,
  10 output tokens, 4.7 tokens/sec, and 2.1 seconds. CPU selection remained
  opt-in and unused.
- No app rebuild or reinstall was needed. C: had 55.5 GiB free during the
  subsequent Qwen3-TTS runtime setup; model weights remain on disk.

### Installed-release Qwen3-TTS 0.6B setup

- In the installed 0.1.32 Electron app, opened Models → Audio and installed
  Custom Voice · 0.6B. Its pinned OpenVINO payload is 2,174,455,357 bytes.
- Fern prepared the isolated speech runtime, then downloaded the model files
  and reported `Model setup complete. Ready to generate speech.` The TTS status
  endpoint reports `custom-0.6b` installed, no error, and the runtime ready.
- In the Electron Audio workspace, created a thread, kept the preset Vivian,
  entered a short synthetic test script, and started generation. The app
  selected Intel GPU automatically, compiled and loaded the model in 89.1s,
  and entered speech synthesis. No take or additional progress appeared after
  a further 3m24s, so the job was stopped from the UI at 5m total. The server
  reported `stopped` and no WAV output was saved. No CPU generation was run.
- Runtime diagnostics also report that the `sox` executable is missing and
  `flash-attn` is unavailable. These were warnings in the diagnostic output;
  they do not establish the cause of the stalled generation. GPU speech
  synthesis remains unverified pending investigation. C: had 54.2 GiB free
  after setup; the 0.6B model is retained.
- Follow-up source/profile inspection: the installed export has no
  `generation_config.json`; the UI request omits `max_new_tokens`, and the
  worker therefore caps generation at 2,048 tokens. The run did not report
  generated-token progress, so the evidence does not distinguish slow token
  generation from a stuck decode. Local data later refreshed to 49.5 GB free,
  83.8 GiB of downloaded models, 21.9 GiB of generation cache, and 0 WAV
  files; the earlier 79.3 GB model figure was stale before the view reloaded.
- Controlled follow-up against the same installed 0.6B export and speech
  runtime: sent a short English script with `device=GPU` and
  `maxNewTokens=128`. OpenVINO again loaded on GPU (25.7s), then remained in
  `Synthesizing speech with the preset voice` with no WAV or further progress.
  Stopped the job after 294.4s total. This shows the stall persists with a
  bounded generation length; it does not identify whether token generation or
  audio decoding is stuck. The check used the API diagnostic path, not a second
  UI generation. No weights were downloaded.
- A further minimum-length request (`maxNewTokens=16`, text `Hi.`, GPU) also
  stayed in synthesis and produced no WAV. The job stopped after 224.7s total;
  model load took 50.7s. This rules out a long prompt and the 128-token ceiling
  as the only causes, but still does not identify the blocked stage.
- Source/config inspection found 16 codec groups in this export. Each generated
  talker frame also runs the code predictor for the remaining 15 groups, so a
  16-frame cap can still invoke hundreds of sequential OpenVINO inference
  steps. This is a plausible latency contributor, not a confirmed hang cause.
- Added local diagnostic progress boundaries around speech-code generation
  and waveform decode in `scripts/qwen3_tts_worker.py`. A direct local-source
  worker run using the existing model and runtime did not reach the new stage
  logs: GPU model loading/compilation remained active for over 205s, then was
  interrupted before inference. This is separate from the installed-app runs;
  the modified local worker has not yet been validated end-to-end or packaged.
- Follow-up with the modified local-source worker in Electron, reusing the same
  installed 0.6B export and runtime through a temporary profile/data root:
  Intel GPU model loading completed, and the UI reported `Speech codes
  generated. Decoding the audio waveform.` The job stayed at that stage for
  3m38s with no take or WAV, then was stopped through the visible UI control.
  The app confirmed `Audio stopped`; the thread still has zero takes. This
  narrows the stall to waveform decoding after token generation. No CPU
  inference, model download, or model cleanup occurred. No new install or app
  release was built for this local-source diagnostic run.
- Isolated the existing OpenVINO speech-tokenizer decoder for a GPU-only
  diagnostic using one synthetic audio-code frame. The available device list
  included `GPU`; decoder compilation took 24.6s. The first GPU inference did
  not return within a further 56s and was interrupted. This independently
  reproduces the slow/hung stage without running the speech language model or
  downloading weights. The helper pads short code sequences to the traced
  325-frame decoder input, which is a concrete path to investigate; no code
  change to that decoder has been made yet.
- Inspected the existing decoder XML: its input is dynamic in the frame
  dimension (`[1, ?, 16]`). A direct GPU inference with a single frame also did
  not return within 60s after a 3.6s compile and was interrupted. Therefore,
  padding to 325 frames is not sufficient to explain the decoder stall. The
  failure is now isolated to execution of this OpenVINO decoder on GPU; its
  cause remains unknown and no fallback to CPU was used. The runtime is
  OpenVINO 2026.4.0 on Intel Iris Xe Graphics (GPU device reported available,
  15.5 GB shared device memory).

### Current GitHub and public-release audit — 2026-10-25

- GitHub reports v0.1.29 as the latest public release. The installed 0.1.32
  package is the locally built candidate. The v0.1.29 installer asset is
  retained in `artifacts/release-test/` and its SHA-256 matches GitHub's
  published digest; it is older than the installed package.
- The repository has no open pull requests. Issues #1 and #2 remain open.
  Issue #1's custom-import flow is covered, and the existing Circulus Klein 9B
  export generated successfully through the Optimum Intel adapter, but the
  other exact user exports listed in the issue are not available here; their
  four reported `D:\Ai\openvino.genai\samples\python\image_generation\model\...`
  paths all fail an existence check on this PC. Issue #2 is blocked by the
  still-open upstream OpenVINO request #4653; its latest comments still say the
  export conversion has not succeeded and ask for an official notebook.
  FLUX.3 was not installed or tested.
- Issues #3 and #4 are closed. No issue state or comment was changed during
  this audit.
- The packaged `release/win-unpacked/Fern.exe` and installed 0.1.32 executable
  are both 225,671,680 bytes and have the same SHA-256
  (`3923B25FAE7E82771D5D165D6E3F0E18877C7BEC9AF57E80A6FD4D25FB07356A`). The
  0.1.32 NSIS installer is present at 475,477,055 bytes. The real-model smoke
  harness was updated to reuse `%APPDATA%\Fern\studio-data\models`, use an
  isolated profile, and wait for runtime checks before enabling Generate. It
  then passed against the installed packaged Electron app: the already
  installed Klein 4B produced a 768×768, 4-step image on Intel GPU in 192.9s;
  logs report OpenVINO `GPU`, and no model weights were downloaded. Output:
  `artifacts/release-test/4b-installed-0.1.32-audit-real-inference.png`.
- In the installed app, Library showed the new render at the top with its
  prompt and preview. Its image count briefly showed 7 immediately after
  navigation, then updated to 8 after the list refreshed (~3s).
- The first Local data screenshot after that run still showed the old 79.3 GB
  model total. Navigating away and back triggered a fresh storage request and
  updated it to 83.8 GiB, consistent with the API's 89,980,505,535 bytes. The
  Model Library also remained on `Checking installed models…` during its
  background runtime scan before eventually populating the catalog; this is a
  long initial wait, not a failed model install.
- The 83.8 GiB model-folder total includes Intel compiled `model_cache` blobs
  beside model weights; the 21.9 GiB generation cache is separately reported.
  These are retained for reuse. No model folders or caches were deleted.
- `node --check` passes for the smoke harness. It uses the installed Fern
  executable and does not require another app build or installation.

### Electron UX and isolated smoke follow-up — 2026-10-25

- Used Windows Computer Use against the installed Fern Electron window. In
  Preferences, confirmed GPU is the default and the CPU selection control is
  off, with explanatory copy stating that CPU is hidden. Enabled the explicit
  CPU opt-in and verified that the separate Generation device menu appeared
  with Available GPU and CPU options. Did not select CPU or run inference on
  CPU. Turned the opt-in back off and verified the app returned to the
  GPU-only display.
- Opened Models and waited for the installed-model scan. Klein 4B, Klein 9B,
  Qwen Image 2.1 Turbo, both Tame Pony exports, and the two linked local Klein
  exports showed their installed/ready states. FLUX.3 remained not installed.
  No model downloads or removals occurred. Tame Pony was only observed in the
  catalog; it was not rerun.
- Ran `npm run test:electron --workspace @fern/desktop`. The app rebuilt from
  the current workspace, then the isolated Electron smoke passed coverage for
  the preload/API bridge, references, model navigation, repository controls,
  dialog IPC, local model add/remove, composer selection, cancellation, and
  source preservation. It used a disposable profile and no model weights.
  During teardown, the Python server logged two client disconnect
  `ConnectionAbortedError` traces; the test exited 0 and reported success.
- Repeated the Electron smoke against the current packaged executable by
  setting `FERN_E2E_EXECUTABLE` to `apps/desktop/release/win-unpacked/Fern.exe`.
  Its isolated profile extracted and ran the bundled Python runtime, verified
  `app.isPackaged`, and passed the same end-to-end workflow checks with exit
  code 0. The packaged and installed Fern.exe files have matching SHA-256
  (`3923B25FAE7E82771D5D165D6E3F0E18877C7BEC9AF57E80A6FD4D25FB07356A`).
- Rechecked the four exact `D:\Ai\openvino.genai\...` folders listed in
  GitHub issue #1; none exists on this PC. The equivalent public Circulus
  FLUX.2 Klein export did complete successfully through the custom-model GPU
  path, as documented above. Issue #1's latest public comment predates that
  successful run and should be updated before considering the report resolved.
- Verified the retained public latest-release asset at
  `artifacts/release-test/Fern-Setup-0.1.29.exe`: 499,627,545 bytes and
  SHA-256 `9DB89ECBBCF505DA1F9EF82D040AB006A47B987747BB4FEAD98433BCF2650E5`,
  matching the GitHub release API digest. GitHub still marks v0.1.29 as latest;
  the installed/package-tested app is 0.1.32.
- Rechecked upstream OpenVINO GenAI issue #4653: it remains open, with no
  official FLUX.3 Klein conversion notebook or successful conversion in its
  latest comments. Fern issue #2 remains blocked by that upstream status.

### Local-source validation follow-up — 2026-10-25

- Ran `npm run check` using the repository `.venv`: TypeScript, Python
  compilation, all 93 Python tests, and the production build passed. The first
  attempt used machine Python and failed to import `defusedxml`; no package was
  installed globally. The repository environment already contained it.
- In the sandbox, one lifecycle test could not create its Windows
  multiprocessing pipe (`WinError 5`), and esbuild could not start a child
  process (`spawn EPERM`). The single lifecycle test passed with normal process
  permissions, then the full check passed with those permissions.
- `npm run test:electron --workspace @fern/desktop` passed against the current
  source build. It exercised the hidden Electron main window, preload/API
  bridge, multi-reference persistence, Models navigation, repository and
  family controls, dialog IPC, local model add/remove, composer selection,
  cancellation, and source preservation. It used a disposable profile and no
  model weights. A request disconnect was logged during teardown; Electron
  exited 0 and the smoke reported success.

### Qwen3-TTS GPU decoder fix — 2026-10-25

- Compared Fern's speech decoder helper with the current OpenVINO notebook
  helper; the implementation and 325-frame traced decoder graph match.
  OpenVINO 2026.4.0 on Intel Iris Xe reported all 2,401 decoder graph
  operations as GPU-supported.
- Dynamic-shape GPU inference did not return within 60s. A one-frame static
  reshape was also not a valid test: the traced graph still returned its
  325-frame output. The matching static `[1, 325, 16]` GPU graph compiled in
  35.9s and decoded in 7.8s, returning finite output of 623,445 samples.
- Updated the GPU speech-tokenizer loader to read the existing OpenVINO IR,
  reshape its input to the traced static frame/quantizer shape, then compile
  that model on GPU. CPU behavior remains unchanged.
- The patched wrapper decoded a one-frame synthetic input on GPU in 7.7s and
  returned a finite 1,365-sample waveform. In the local-source Electron Audio
  workspace, `Hi.` with preset Vivian completed on Intel GPU and saved a
  2.3-second, 24 kHz mono WAV in 98.1s total. The saved output is finite and
  non-silent (peak 0.700, RMS 0.104); the take card showed `Intel GPU`, and
  play/pause controls responded. This reused the existing 0.6B export/runtime;
  no weights were downloaded or removed.
- After the change, the full source check passed: TypeScript, Python
  compilation, all 93 Python tests, and production build. A 0.1.33 local
  installer is being prepared for installed-Electron verification.

### Fern 0.1.33 packaged verification — 2026-10-25

- Built `Fern-Setup-0.1.33.exe` locally after the Qwen3-TTS GPU decoder fix. The bundled runtime audit passed, the archive contains 27,871 files, and the installer is 475,477,467 bytes (SHA-256 `02D711ACBB634F4696E30B61B2CBCE97CD2E38C1F7F9AED831BBAC22F75F7DA7`). No release was published.
- The hidden isolated Electron smoke passed against `release/win-unpacked/Fern.exe` with exit code 0. It verified the packaged app flag, extracted bundled Python runtime, preload/API bridge, model navigation, and workflow controls. It used no weights. Sandbox attempts to launch Electron returned `spawn EPERM`; the same smoke passed with normal process permissions. Two connection-aborted traces during shutdown were logged before the successful exit.
- The installed 0.1.32 app's existing Qwen3-TTS take was already confirmed as Intel GPU and finite/non-silent. The installer was later run through File Explorer after the user approved 0.1.33; see the installed-app follow-up below. Direct `launch_app` attempts had timed out, so File Explorer was opened and the installer launched from the release folder.
- The local Preferences view confirms GPU is the default, CPU selection is hidden until the `Allow CPU selection` preference is enabled, Intel GPU is ready, and NVIDIA is unavailable. No CPU inference was run. Tame Pony was not rerun; no model weights were downloaded or removed.
- GitHub issues #1 and #2 remain open. Issue #1's latest comment now documents the installed 0.1.32 custom Klein 4B registration/GPU-dispatch test and the VAE config failure, and requests an accessible copy/config for one of the exact user exports. Those four folders are unavailable on this PC. Issue #2 remains blocked by OpenVINO GenAI issue #4653. No public issue changes were made in this pass.

### Qwen3-TTS 1.7B local-source UI test — 2026-10-25

- Installed Qwen3-TTS Custom Voice 1.7B once through the local Electron Models → Audio UI. Its declared download was about 4.20 GB, stored in the shared Fern data root; no other model was removed or downloaded. Disk space remained above Fern's 20 GB reserve.
- Generated with preset Vivian on Intel GPU. The first-run GPU setup/compile and one-word `Hi.` take completed in 119.4 seconds but produced only 0.4 seconds of audio, so that tiny sample alone is not treated as a useful quality check.
- Reused the loaded 1.7B model for `Fern works locally with Intel graphics.` The UI saved a 4.0-second take in 52.8 seconds, identified it as Intel GPU, and the in-app player advanced to the end. No CPU path was used.
- Diagnostics warned that flash-attn and SoX are absent; inference completed despite these warnings. The normal-length take passed the UI playback check. No standalone WAV waveform analysis was performed.

### Fern 0.1.33 installed-app verification — 2026-10-25

- Launched the local `Fern-Setup-0.1.33.exe` from File Explorer after the user approved this version. The GUI installer completed and opened `C:\Users\codex\AppData\Local\Programs\@ferndesktop\Fern.exe`; Windows file metadata reports version 0.1.33.0. The existing Fern profile/workspace data remained available after installation.
- In the installed app's Preferences, confirmed `Allow CPU selection` is off, the app says CPU is hidden, and Intel GPU is Ready. No CPU inference was run.
- In installed Models → Audio, Custom Voice 0.6B and 1.7B both showed Installed. The existing 1.7B model folder contains 26 files totaling 4,196,234,435 bytes in the shared app-data store; no second model copy was created and no model download occurred during upgrade/testing.
- From a new installed-app Audio thread, generated `Fern works locally with Intel graphics.` with preset Vivian and 1.7B. The take completed in 101.7 seconds, saved 3.1 seconds of audio, and showed `Intel GPU`. The in-app player advanced to the end. The first run compiled the model/tokenizer for this installed process; no CPU fallback occurred.

### Fern 0.1.33 installed text-chat verification — 2026-10-25

- Reviewed the existing installed-app Qwen3 4B thread in the Electron UI; the assistant returned the exact expected response, `Qwen3 local GPU smoke test passed.`
- Expanded Response details and confirmed Qwen3 4B Instruct 2507 ran on `GPU`, generated 10 output tokens at 4.7 tokens/sec in 2.1 seconds, with the expected temperature/top-p/seed/max-token metadata. No CPU fallback occurred and no model download was needed.
- Current installed Models → Text shows Qwen3 4B Instruct 2507 as Installed (3.77 GiB), with one local model directory. This reused the installed model and existing conversation.
- Current GitHub audit still shows open issues #1 (custom OpenVINO models) and #2 (FLUX.3 setup), with no open PRs. Issue #1's exact four reporter directories remain unavailable on this PC; the latest maintainer comment documents the Klein 4B VAE-config failure and asks for an accessible export/config. Issue #2 has no Fern comments and remains blocked on upstream OpenVINO GenAI issue #4653, which remains open. No comments, issue state, releases, or other GitHub data were changed.
- GitHub's current `releases/latest` API still points to v0.1.29 (published 2026-10-22; 499,627,545-byte installer). That public build predates the local 0.1.33 GPU decoder fix, so installed-app verification used the locally built 0.1.33 artifact rather than installing the stale public release. The local 0.1.33 installer was not published.

### Installed custom SD 1.5 model — 2026-10-25

- In installed Fern 0.1.33, downloaded the official `OpenVINO/stable-diffusion-v1-5-int8-ov` INT8 OpenVINO export using Models → Add custom model, family Stable Diffusion 1.x / 2.x. Fern registered it as installed; the existing model directory is 1,075,956,851 bytes (~1.0 GiB). It remains installed for reuse. No reinstall, redownload, CPU inference, or model cleanup occurred.
- Generated in the installed Electron UI at 512×512, 20 steps, guidance 7. The Render Info panel reports Intel GPU. The first prompt, `A red cube on a plain gray background.`, completed in 147.0s but the saved result was a gray grid with bright red squares and did not depict a recognizable cube. This was a poor output and is not counted as a successful semantic result.
- Reused the loaded model/runtime for the model card's documented sample prompt, `sailing ship in storm by Rembrandt`. It completed on Intel GPU in 57.9s and produced a recognizable ship in a storm, visually confirming the exported SD 1.5 model can generate a coherent result in the installed app.
- Both runs displayed `Step 21/20` after `Step 20/20`, even though generation then completed. Track this as a progress reporting off-by-one UX issue for the custom Stable Diffusion pipeline. The first run also spent about 179s loading/compiling OpenVINO before inference; the second reused the in-process pipeline.
- Checked the local PNG output directly as well as through the Fern preview; the first result's grid pattern is in the saved file and is not a thumbnail/preview artifact.

### GitHub issue status refresh — 2026-10-25

- Refreshed `xgirls-dev/fern`: issues #1 (custom OpenVINO imports) and #2 (FLUX.3 setup) are still open; there are no open pull requests. The four exact directories requested in #1 are absent locally. Issue #2 remains unverified by design because the upstream FLUX.3/OpenVINO integration is still pending.
- Prepared an evidence-based follow-up for issue #1 after the installed SD 1.5 test, but no comment was posted. The connected comment action requires a `pr_number`; auto-review rejected using issue #1 as a PR target and prohibited an indirect workaround. No issue contents or state were changed.

### Current release/install state refresh — 2026-10-25

- GitHub's `releases/latest` API still identifies v0.1.29 (published 2026-10-22) as the latest public release. Its 499,627,545-byte installer in `artifacts/release-test` hashes to `9DB89ECBBCCF505DA1F9EF82D040AB006A47B987747BB4FEAD98433BCF2650E5`, matching the release API asset digest. It was not installed because it predates the current local build and the user explicitly identified it as stale.
- The local Fern 0.1.33 installer is 475,477,467 bytes with SHA-256 `02D711ACBB634F4696E30B61B2CBCE97CD2E38C1F7F9AED831BBAC22F75F7DA7`. Windows file metadata reports the installed app as 0.1.33.0. The installed `Fern.exe` and current `release/win-unpacked/Fern.exe` match (`98E920C1A7C67B24BC69C78ECA297FA49737260312C536F281AA0EA23EF7F1EC`); their `resources/app.asar` payloads also match (`513383E8C93F8B9236616C678D429234F63CBFD15036F9A387513BA32248D54E`).
- C: has 39.6 GiB free after the retained SD 1.5 download and generated outputs. The large model families were not downloaded or removed in this pass.

### CPU opt-in guard and local text UI test attempt — 2026-10-25

- Auditing the in-progress real-model text UI test found it selected CPU in Preferences and then generated a retry on CPU. Updated the test to verify the explicit CPU opt-in control, switch back to GPU before inference, and require GPU response metadata. No application code changed and no CPU generation was run.
- `node --check tests/ux-text-live.mjs` passed. The real-model test could not reach the UI: its first attempt found the expected `tmp/text-live` scratch parent absent; after creating that parent and starting the isolated local API, Playwright stopped because `chromium_headless_shell-1248` is not installed in this account. The model was not loaded, and no model was downloaded. The installed-app Preferences screen was checked through Computer Use and showed CPU selection disabled, Intel GPU ready, with no inference in progress.

### Installed Local Data view — 2026-10-25

- Computer Use inspection of Fern 0.1.33 → Local data reports 39.5 GB free of 952.6 GB, 23.6 GB generation cache, 89.8 GB downloaded models, 8.2 MB generated images, and 145.2 KB audio. The app states downloaded models are preserved when local data is cleared. No cache, models, outputs, or preferences were deleted.

### Current audit and Fern 0.1.34 verification — 2026-10-25

- Inspected the installed 0.1.33 Electron app through Computer Use. Image settings have no device selector; Preferences keep CPU selection off and show Intel GPU Ready. Image model manager recognizes the installed SD 1.5 export and existing model library.
- The saved Qwen3 4B conversation shows the expected response and GPU metadata: 21 input tokens, 10 output tokens, 4.7 tokens/s, 2.1 seconds. The existing Qwen3-TTS 1.7B take shows Intel GPU, 3.1 seconds of audio, and working playback controls. No model downloads or CPU inference were done in this audit.
- Found an image progress defect in the installed SD 1.5 run: its final progress callback displayed `Step 21/20`. The custom Diffusers callback now ignores a terminal callback whose index equals the configured step count. Added a regression test that simulates this extra callback.
- Verification on the source tree: TypeScript typecheck passed, Python compile passed, all 93 Python tests passed from `.venv` with normal Windows multiprocessing permissions, all 12 renderer UX suites passed, and local Electron smoke passed. Initial sandbox attempts were blocked by `spawn EPERM` / WinError 5; the tests passed after rerunning with the required process permissions.
- The custom image progress fix passed its regression test. Typecheck passed, all 94 Python tests passed from `.venv`, all 12 renderer UX suites passed, and local Electron smoke passed after rebuilding.
- Built `Fern-Setup-0.1.34.exe` (475,477,573 bytes; SHA-256 `D97AC96F1A7C2B5E3E2063B3CDDD1718427DACC3C6FC2BF66D368F4EC8E4BE15`). Packaged Electron smoke passed using a disposable profile, with no model weights. The installer is unsigned. With user approval, upgraded the existing 0.1.33 installation through its GUI. The installed `Fern.exe` reports ProductVersion `0.1.34.0`, and existing Fern profile data and threads remained available.
- GitHub's latest public release is still v0.1.29 (499,627,545 bytes; published 2026-10-22; API digest `9DB89ECBBCCF505DA1F9EF82D040AB006A47B987747BB4FEAD98433BCF2650E5`), so it was not installed over the newer local build. Upstream OpenVINO GenAI #4653 remains open, keeping FLUX.3 out of this test pass.
- Fern issue #1 remains open. Its earlier maintainer comment documents a local FLUX.2 Klein 4B VAE-config failure and asks for one of the reporter's four exact exports. A later commenter linked `OpenVINO/Juggernaut-XL-v9-int8-ov`; its official Hugging Face card describes a 3.5 GB INT8 SDXL OpenVINO export supported by Optimum Intel 1.27+. This is a useful SDXL compatibility case, but it is not one of the reporter's four exact exports. No issue comments or states were changed.

### Fern 0.1.34 installed Electron SDXL test — 2026-10-25

- Through the installed app's Models view, downloaded and registered the issue-linked `OpenVINO/Juggernaut-XL-v9-int8-ov` under the Stable Diffusion XL family. Fern reported `Model added to Fern` and `Installed · Hugging Face export downloaded`; it appears as a selectable image model. This was a roughly 3.50 GB model, so it is retained under the user's guidance to remove only very large downloads.
- Preferences visibly show `Allow CPU selection` off, CPU hidden, and Intel GPU Ready. The generation settings panel explicitly said `Fern will use the available Intel GPU`; activity recorded `Queued Juggernaut-XL-v9-int8-ov on Intel GPU: 1024x1024, 30 steps, guidance 7.0`. No CPU inference was used.
- Generated `A majestic lion standing on a rocky outcrop at sunset, detailed wildlife photograph.` in the installed Electron UI. The render completed in 335.6 seconds and produced a recognizable lion. Render Info confirms 1024×1024, 30 steps, guidance 7, Intel GPU, model `Juggernaut-XL-v9-int8-ov`, revision `local custom`. This validates a current custom OpenVINO SDXL export in Fern but does not resolve issue #1's separate FLUX.2 VAE-config failure or test the reporter's four missing exports.
- Disk check after the model download and image run showed about 32.04 GiB free on C:. No model or generated image was deleted.
- Closed and relaunched the installed app through Windows UI. Fern restored the image thread, preview, prompt, 1024×1024 metadata, and Juggernaut model selection after backend reconnect; no download was repeated. The generated output and model registration therefore survived an app restart.

### Fern 0.1.34 installed Qwen Image 2.1 Turbo GPU test — 2026-10-25

- Reused the already-installed Qwen Image 2.1 Turbo · official model from a new image thread; no download or reinstall occurred. The image settings view showed 1024×1024, one image, eight fixed steps, and “Fern will use the available Intel GPU.”
- Generated `A red apple on a gray table.` through the installed Electron UI. The output is a coherent red apple on a gray table. Render Info confirms Intel GPU, model `Qwen Image 2.1 Turbo · official`, revision `84d3f71fff32fc6c4740b89f5556657d0c65af27`, 8 steps, 1024×1024, and 13m 21s.
- First-load diagnostics warned that the Qwen VAE encoder and decoder configurations omit `scaling_factor`; despite these warnings, this render completed and displayed correctly. The activity log recorded all 8 steps and batch completion.
- The ~23.2 GB model remains installed for reuse (the user requested cleanup only for huge 50–70 GB downloads). C: has 30.50 GiB free. No model or generated output was deleted.
- Inspected all three Models categories in the installed UI. Image lists the existing Tame Pony, Klein, SD 1.5, Juggernaut SDXL, and Qwen image exports; Text lists installed Qwen3 4B; Audio lists installed Custom Voice 0.6B and 1.7B. FLUX.3 remains not installed, and voice-clone/design models remain not installed. No other model action was taken.

### Fern 0.1.34 installed Qwen3-TTS GPU decoder test — 2026-10-25

- Reused the existing Custom Voice 0.6B export in a new Audio thread. The installed Electron UI showed Qwen3-TTS 0.6B Ready, Vivian preset, and the generation job’s runtime status explicitly said it was loading for GPU.
- Generated `Hi.` in the installed 0.1.34 app. Progress reached `Speech codes generated. Decoding the audio waveform.`; the job then completed and saved a 1.2-second take in 71.6 seconds total. The take card reports `Intel GPU` and 0.6B. This verifies the packaged GPU decoder path now returns audio where the earlier installed 0.1.32 test stalled at decode.
- Started playback through the take’s player; its position advanced from 0.6s to 1.1s and playback stopped at the 1.2s end. No model download, CPU inference, cleanup, or rebuild was done for this test.
- Final Preferences inspection confirms `Allow CPU selection` remains off; the UI says CPU is hidden, reports Intel GPU as the selected device, and marks the Intel GPU Ready.

### Fern 0.1.34 installed custom Klein 4B GPU recheck — 2026-10-25

- Reused the existing `flux2-klein-4b-int4` local export linked in the installed Models view. No model download, reinstall, removal, or release build was performed. This export is a separate compatibility case from the four FLUX.2 exports requested in GitHub issue #1.
- In the installed Electron UI, selected the existing custom Klein 4B entry, set a 512×512 one-image canvas, and confirmed the UI stated that Fern would use the available Intel GPU. Ran `A red cube on a plain gray background.` at 4 steps, guidance 1, seed `994286815`.
- The Optimum Intel pipeline loaded, completed all four steps, and produced a recognizable red cube in 34.2 seconds. Render Info confirms `Intel GPU`, model `flux2-klein-4b-int4`, local-custom revision, 512×512, and 4 steps.
- This resolves the earlier local custom Klein 4B VAE batch-normalization-stats failure for this export in installed 0.1.34. The current path uses `OVFlux2KleinPipeline`; it does not establish that the four reporter-provided exports work, because those exact folders remain unavailable.

### Fern 0.1.34 source regression checks — 2026-10-25

- `npm run typecheck` and `npm run check:python` passed. The root `npm run check` stopped at its Python suite because system Python was selected and lacked `defusedxml`; running the full suite with the repository `.venv` passed all 94 tests. Its one IPC lifecycle case required execution outside the sandbox, where it passed.
- `npm run test:ui` passed all 12 renderer UX suites when run outside the sandbox so Playwright could spawn Chrome.
- `npm run test:electron --workspace @fern/desktop` rebuilt the local Electron app and passed its isolated smoke flow: hidden window, preload/API bridge, multi-reference persistence, Models navigation, family/repository controls, native-dialog IPC, local model add/remove, model selection, cancellation, and preservation of linked model files. It exited cleanly and removed its temporary test profile.

### Fern 0.1.34 installed custom Klein 9B GPU recheck — 2026-10-25

- Reused the existing linked `flux2-klein-9b-circulus-int4` export; no download, reinstall, removal, or release build was performed. This is the local 9B Circulus export based on FLUX.2 Klein 9B, not confirmation of the reporter's exact `FLUX.2-klein-9B-INT4` OpenVINO GenAI sample directory.
- In the installed Electron UI, selected the custom 9B export, set a 512×512 canvas and one image, and verified Fern would use the available Intel GPU. Generated `A red cube on a plain gray background.` with 4 steps, guidance 1, and seed `994286815`.
- All four steps completed and a recognizable red cube was displayed in 1m 6s. Render Info confirms `Intel GPU`, model `flux2-klein-9b-circulus-int4`, local-custom revision, and 512×512. Together with the Klein 4B recheck above, both locally available custom Klein sizes pass the current Optimum Intel custom pipeline.
- Exact-name Hugging Face searches did not surface the reporter's three non-FLUX export folder names as public model repositories. This does not substitute for access to their exact local folders; those exports remain unverified.

### FLUX.3 overlay packaging audit (static only) — 2026-10-25

- Inspected the in-progress isolated overlay without installing it or touching the FLUX.3 model. The release environment pins `torch==2.14.1`; the overlay pins `torchvision==0.29.1+cpu` and installs with `--no-deps`, so it will not replace the app's OpenVINO-enabled Torch runtime. The official PyTorch CPU wheel index lists a CPython 3.12 Windows x64 wheel for this torchvision version, and PyTorch's 2.14 release notes say TorchVision 0.29 is ABI-stable with Torch 2.14+ ([wheel index](https://download.pytorch.org/whl/cpu/torchvision/), [PyTorch 2.14 release notes](https://pytorch.org/blog/pytorch-2-14-release-blog/)).
- Static audit only: no overlay install, FLUX.3 model download, conversion, or inference was performed. Runtime compatibility remains unverified while the upstream conversion notebook/request is unresolved.

### Fern GitHub issue audit — 2026-10-25

- Refreshed all open issues in `xgirls-dev/fern`: #1 custom OpenVINO model imports, #2 FLUX.3 setup, #6 FLUX.2 Klein 4B LoRA support, and #7 the `rupeshs/flux3-image-klein-int4-ov` model request. A fresh search found no open pull requests. Rechecked issue #1 comments: the reporter's latest note still points to the four exact directories in the issue body; those remain unavailable locally. No GitHub issue comments, labels, or states were changed.
- Issue #1 remains partly verified: the available custom Klein 4B and 9B exports now generate on Intel GPU in installed 0.1.34, and the issue-linked Juggernaut XL SDXL export also generated. The reporter's four exact directories remain unavailable locally, so their compatibility is not established.
- Issue #6 has no existing Fern LoRA selection workflow. The initial audit incorrectly reported that the current OpenVINO GenAI support matrix excluded Klein LoRA; the later backend re-audit below corrects that stale conclusion. The Optimum pipeline still lacks a working LoRA path, so GenAI integration must be proven against Fern's actual local export before adding UI controls.
- Issue #7 remains deferred with FLUX.3: a fresh check confirms linked upstream OpenVINO GenAI #4653 is still open (last updated 2026-10-20), and the latest upstream comment still describes the community conversion as incomplete and requests an official notebook. No FLUX.3 repo/model was installed or tested.
- Computer Use in installed Fern 0.1.34 moved to Preferences and confirmed `Allow CPU selection` is off; the UI says CPU is hidden and reports Intel GPU for the current model. No generation or model action occurred during this inspection.
- Rehashed the current installed Electron files against `apps/desktop/release/win-unpacked`: installed and packaged `Fern.exe` are both 225,671,680 bytes with SHA-256 `B07C7BBD1547B017FA618838348A61BA812843A2836156756F5DE7C241610A0C`; both `resources/app.asar` files are 1,641,180 bytes with SHA-256 `1FEFC2223276BDE664004DFFF3ED551F619CE71B0C62BF7D7103017A3255BDDA`. Windows reports ProductVersion `0.1.34.0`. The matching local installer is `Fern-Setup-0.1.34.exe` (475,477,573 bytes, SHA-256 `D97AC96F1A7C2B5E3E2063B3CDDD1718427DACC3C6FC2BF66D368F4EC8E4BE15`). No reinstall or download was performed during this integrity check.
- Current C: free space is 31.0 GiB. No new model downloads were started; the existing model set was left intact.

### Fern 0.1.35 local Electron GUI launch preflight — 2026-10-25

- The 0.1.35 packaged smoke test passed, but a direct visible launch of `release/win-unpacked/Fern.exe` with a temporary user-data profile under the workspace failed before Fern rendered. Chromium logged access-denied errors while setting sandbox permissions on its `Cache` and `Network` directories (`0x5`), followed by a Windows breakpoint dialog. Retrying with the normal profile also hit a profile lock/access-denied startup failure. This is an environment/profile-permission failure; it did not reach model selection, download, setup, or inference.
- Closed the existing 0.1.34 UI before the retry, reopened it afterward, and confirmed its data and GPU preference remained intact. Removed only the temporary profile and startup logs created by the failed attempt. The actual 0.1.35 GUI install test remains pending approval; no model download or deletion occurred.

### Fern 0.1.34 installed TTS warm-pipeline baseline — 2026-10-25

- In the visible installed Electron UI, reused the ready Qwen3-TTS 0.6B model and generated two takes in the same thread using the default preset voice. Preferences has CPU selection off; both take cards explicitly report `Intel GPU`.
- The first 4.3-second take completed in 74.5 seconds, including warmup. The second 5.0-second take reused the loaded model and completed in 25.4 seconds.
- Expanded the second take's Activity timeline. It records `Speech codes generated. Decoding the audio waveform.` twice at +18.3s and `Audio waveform decoded.` twice at +25.4s. This reproduces the exact progress-wrapper accumulation fixed in local 0.1.35. The existing model was neither downloaded nor removed.
- Played Take 2 from its card; the player advanced to the 5.0-second end. No model download, setup, or CPU generation occurred.
- Rechecked the installed 0.1.34 model library in the Electron UI: Klein 4B/9B, Tame Pony FP16/INT8, Qwen Image Turbo (23.2 GB), and linked/Hugging Face exports show installed/runtime-ready states; FLUX.3 remains not installed. No model action was taken. The 0.6B and 1.7B TTS entries both show Ready.
- Preferences confirms `Allow CPU selection` is off, CPU is hidden, Intel GPU is ready, and OpenVINO · Optimum Intel is the active backend. This was an inspection only and did not change settings.

### Current GitHub open-issue and discussion recheck — 2026-10-25

- GitHub search still returns open issues #1, #2, #6, and #7. Comment fetches show no Fern discussion on #2, #6, or #7. Issue #1 has three comments: the previous Fern update documenting that the 0.1.32 Klein 4B export failed with a missing VAE batch-normalization config, and the reporter's later link to `OpenVINO/Juggernaut-XL-v9-int8-ov`. The four original sample folders remain named in the issue body; they are unavailable on this PC. Subsequent 0.1.34 local runs of Klein 4B/9B and the linked Juggernaut XL export are recorded above, but none verifies those four exact folders.
- No GitHub comment or issue state was changed. Current open discussions remain actionable only with access to the reporter's exact exports for #1, a supported upstream conversion/runtime for FLUX.3 (#2/#7), or a Klein LoRA-compatible model export/runtime path for #6.

### FLUX.2 Klein LoRA backend re-audit — 2026-10-25

- This supersedes the earlier note that Klein LoRA support was unavailable upstream. The current OpenVINO GenAI supported-model page lists FLUX.2 Klein LoRA support, and the installed `openvino-genai==2026.4.1.0` Python binding exposes `Adapter`, `AdapterConfig`, and the image-pipeline `adapters` argument. The upstream OpenVINO GenAI Klein support issue #3872 was closed after its implementation PR #3930 merged.
- Fern's release pins `openvino-genai==2026.4.1.0` but currently runs Klein through the separate Optimum Intel `OVFlux2KleinPipeline` (Optimum Intel `1.27.0.dev0+7234214`), whose transformer component lacks `load_lora_adapter`; the renderer has no LoRA workflow. So upstream's new API does not automatically complete Fern issue #6.
- Tested the existing 4B export with GenAI on Intel GPU. Loading its original directory failed because `vae_decoder/config.json` lacks the batch-normalization arrays; Fern stores those arrays in `vae_bn_stats.npz`. A temporary compatibility overlay, made with junctions to the existing weights and a copied VAE decoder config populated from that sidecar, loaded successfully as `Text2ImagePipeline` on GPU. The installed model and app data were not modified; no model or adapter was downloaded. A 76 MB, Apache-2.0 FLUX.2 Klein 4B LoRA candidate is identified for an end-to-end test, but the direct HF CLI request could not connect from this shell, so no partial download was retained.
- OpenVINO GenAI issue #4653 remains open and assigned, and its October 20 comment says the FLUX.3 conversion is incomplete and an official notebook is needed. It remains deferred per scope; no FLUX.3 model was downloaded or tested.

### FLUX.2 Klein LoRA runtime compatibility probe — 2026-10-25

- Downloaded both 72.5 MB Apache-2.0 safetensors variants from `fal/flux-2-klein-4b-spritesheet-lora` in Chrome: the original `flux-spritesheet-lora.safetensors` and its ComfyUI-converted counterpart. Both were retained in Downloads for reuse. No base model was downloaded, replaced, or deleted.
- Reused the existing local 4B export through the temporary GenAI compatibility overlay and explicitly selected the Intel GPU. `openvino_genai.Adapter` parsed each adapter, and `Text2ImagePipeline(..., "GPU", adapters=config)` loaded successfully for both formats. Inference failed for both with an OpenVINO missing-port error: `Port for tensor name hidden_states.9 was not found.` The existing Transformer IR exposes only the `hidden_states` input (along with four other model inputs), so these adapters cannot run on this export through the current GenAI path.
- This is a concrete export/runtime compatibility blocker, not evidence that the current Fern Optimum pipeline supports LoRA. No UI, runtime, or model files were changed. Leave issue #6 open pending a Klein LoRA-compatible export or an upstream adapter mapping for this IR topology; do not present LoRA selection in Fern until it passes GPU inference.
- Current official OpenVINO GenAI documentation lists FLUX.2 Klein LoRA support; its table describes supported model architecture, which does not guarantee compatibility with every existing custom export. See [supported models](https://openvinotoolkit.github.io/openvino.genai/docs/supported-models/), [LoRA adapter guide](https://openvinotoolkit.github.io/openvino.genai/docs/guides/lora-adapters/), and the [tested candidate adapter](https://huggingface.co/fal/flux-2-klein-4b-spritesheet-lora).

### Installed Electron and current release refresh — 2026-10-25

- Used Computer Use mouse input in the installed Electron app (0.1.34) to open Preferences and Models. Preferences shows `Allow CPU selection` off and the selected 9B Klein model on Intel GPU. The Models view finished loading and showed Klein 4B/9B, Tame Pony SDXL FP16/INT8, and Qwen Image 2.1 Turbo installed; FLUX.3 is not installed. No install/remove action or inference occurred during this inspection.
- GitHub's `releases/latest` endpoint still identifies public v0.1.29 (2026-10-22), whose installer asset is 499,627,545 bytes and has SHA-256 `9db89ecbbccf505da1f9ef82d040ab006a47b987747bb4fead98433bcf2650e5`. It is stale relative to the local 0.1.35 build and was not installed.
- Local `Fern-Setup-0.1.35.exe` is 475,477,580 bytes with SHA-256 `57E2D9F12607650150F43AB48F5C266EEE158259DA6D70D1325D95707BD4E31D`. Its packaged smoke and source regression checks are recorded above. GUI installation of this exact new installer is still awaiting approval; installed 0.1.34 remains available for UI checks.
- Refreshed GitHub and found open issues #1, #2, #6, and #7; no issue or release was modified. No FLUX.3 download or test was performed.

### 0.1.35 release wiring audit — 2026-10-25

- Root `package.json`, `apps/desktop/package.json`, and the local installer all report 0.1.35; Windows file metadata reports ProductVersion 0.1.35.
- The local `npm run package` script invokes electron-builder with `--publish never`. The GitHub release workflow only publishes from a tag, an explicit workflow dispatch, or a main-branch commit marked `[publish-release]`; no tag, dispatch, commit, or GitHub release mutation was performed in this audit.
- The public latest endpoint still points to v0.1.29. Treat 0.1.35 as a local verification candidate until an authorized publish flow creates a new public latest release and its downloaded asset is checksum-verified.

### Real-model Electron smoke harness audit — 2026-10-25

- Reviewed `apps/desktop/e2e/real-model-smoke.mjs`. Its default device is AUTO, but AUTO status could previously pass without the test asserting which hardware was selected; the final output now asserts the runtime selected Intel or NVIDIA GPU and that image metadata records the same device. CPU remains a separate explicit Preferences branch.
- The original script automatically confirmed in-app removal of a model above 50 GB after a run (and on failure). That is an action-time deletion requiring human confirmation. The harness now refuses to start downloads of models at or above 50 GB and has no model-removal action; oversized-model installation and cleanup must be handled as a separately confirmed UI test.
- `node --check apps/desktop/e2e/real-model-smoke.mjs` passed. No Electron/model inference was launched in this audit step.

### Fern 0.1.35 current-source regression rerun — 2026-10-25

- `npm run typecheck` passed, and `.venv\Scripts\python.exe -m compileall -q scripts` passed.
- The Python suite passed 95/95 outside the sandbox. Its first sandboxed run passed 94 tests but Windows denied the multiprocessing named-pipe creation in one worker lifecycle test; that case passed when rerun alone outside the sandbox, then the full suite passed outside it.
- `npm run test:ui` passed all 12 renderer UX suites, including composer/model workflows, thread lifecycles, responsive layouts, large-gallery scale checks, and text workflows.
- `npm run test:electron --workspace @fern/desktop` rebuilt the 0.1.35 source renderer/main bundles and passed the Electron integration smoke (preload/API bridge, image references, model controls, native dialog IPC, local model linking/removal, and source preservation). The backend logged two aborted status-response writes while the renderer closed requests; the smoke completed with exit code 0. This test used an isolated temporary profile and did not download, remove, or infer with a model.
- `git diff --check` passed; Git only warns that it will normalize line endings in this report. These checks verify the current local source build. The visible 0.1.35 installer upgrade remains separately pending exact action-time approval.

### Issue #1 public-export lookup — 2026-10-25

- The current issue body names these exact export folders: `FLUX.2-klein-9B-INT4`, `Heartsync-NSFW-Uncensored-LCM-pony_OV`, `masterPro_noobV3VAE_ov_int8_hybrid`, and `waiREALMIX_v70_ov_int8`. Searched Hugging Face for the changed exact `waiREALMIX_v70_ov_int8` name; no matching OpenVINO export repository surfaced. Search results include a 6.94 GB `waiREALMIX_v70.safetensors` source checkpoint, but that is not the reporter's OpenVINO export and would require separate conversion; it was not downloaded.
- This leaves the four exact reporter-provided export folders unverified. Fern's generic local-export flow and the available Klein/Juggernaut examples remain verified elsewhere in this report; those do not substitute for the named folders.

### Fern 0.1.34 Voice Clone 0.6B GUI install check — 2026-10-25

- Used Computer Use mouse input in the installed Electron app's Models → Audio page to install Voice Clone · 0.6B. Fern moved through “Preparing the local speech environment” and download progress, then marked the model Installed. No app reinstall was involved.
- The pinned catalog model is 2,192,439,518 bytes. The installed folder is `studio-data/models/qwen3-tts/base-0.6b-OV`; its marker records revision `e1b0f4cc4958cb6b2a9e9e1c7a2faf07b6b97af8` and `verifiedSha256: true`, and the speaker encoder required for cloning is present. C: reports 28.02 GiB free after installation.
- Started a fresh Audio thread, selected Clone a voice, and confirmed 0.6B is Ready. Entered the path to a five-second WAV previously generated by Fern in the native file dialog, but Computer Use could not activate the dialog's Open button: the target-window recovery retry still reported that the click landed on a child window. The reference was not attached and no clone inference ran. The native dialog remains open; the voice-clone run is pending a working dialog target.

### Real-model smoke download space preflight — 2026-10-25

- The packaged Electron smoke already refuses models at or above 50 GB. It now also refuses a download without a positive catalog size or when the download would leave under 4 GiB free on the model volume.
- `node --check apps/desktop/e2e/real-model-smoke.mjs` passed. A direct Node `statfs` probe of the active Fern data root returned 30,080,069,632 available bytes (28.01 GiB), confirming the Windows filesystem check works on this machine. No model download was started by this preflight change.

### Current GitHub issue follow-up — 2026-10-25

- Refetched Fern issues #1, #2, #6, and #7 and their available comments. All four remain open. #1 still needs one of the reporter's exact OpenVINO exports to validate; #2 and #7 remain tied to FLUX.3; #6 is the new FLUX.2 Klein LoRA request and has no comments yet. No GitHub state or comments were changed.
- Looked for an already-exported Klein model that could provide a meaningful LoRA test without conversion. `HelloSun/FLUX.2-klein-4B-OpenVINO-INT4` is an Apache-2.0 Optimum Intel/diffusers export. Its card documents `OVDiffusionPipeline` and CPU-only benchmark images; it does not document a GenAI `Text2ImagePipeline` export or LoRA adapter compatibility. It therefore does not address the failing `hidden_states.9` mapping on Fern's existing GenAI probe, and was not downloaded. This keeps the test aligned with the GPU-only inference requirement.
- The installed 0.1.34 UI/Audio model-download verification remains completed. Clone inference is still pending because the native file picker could not be targeted through Computer Use; the skill's one-retry recovery was exhausted in that interaction. Current-source 0.1.35 checks are already recorded above; only its approved GUI upgrade and installed-Electron test remain outstanding.

### Release and native-picker revalidation — 2026-10-25

- Reopened GitHub's `/releases/latest`; it redirects to `v0.1.29`, confirming that the public release is older than local source/installer 0.1.35. No stale public release was installed. The local 0.1.35 installer remains a separate pending GUI-upgrade candidate.
- Reobserved the open Voice Clone file picker using the Computer Use `sky` accessibility API. The WAV path is still populated and the clone form remains in the installed Electron app. One fresh `sky.click` on the observed Open control was still attributed to the Fern parent window rather than its native child dialog; stopped after the failed retry. No reference file attached and no clone inference ran.

### Installed model storage audit — 2026-10-25

- Read-only recursive file-size inventory of `studio-data/models` found apparent sizes: Qwen Image 2.1 Turbo 43.61 GiB, FLUX.2 Klein 9B 18.18 GiB, FLUX.2 Klein 4B 8.72 GiB, Qwen3-TTS 7.98 GiB, custom image models 5.40 GiB, and SDXL exports 4.25 GiB and 3.25 GiB. C: has 30,074,286,080 free bytes (28.01 GiB).
- The Qwen Image 2.1 Turbo folder is the only model directory near the user's very-large-download cleanup threshold. Other installed models remain in place. Do not start another large model download until cleanup or additional space is available; any removal should use Fern's model-management flow, which is currently obstructed by the native file-picker window.

### Qwen model cleanup and Windows read-only removal fix — 2026-10-25

- Confirmed Qwen Image 2.1 Turbo had completed two Intel GPU generations in the installed Electron app. Fern's model-remove handler initially removed some files but failed on read-only OpenVINO `.blob` files and marked the model `repair-needed`. Cleared read-only attributes only inside that Qwen model folder, then retried the same Fern `/api/models/remove` handler. It completed, reported `not-installed`, and removed the remaining model tree; the successful Qwen output image and other model folders remain. C: now has 76,430,114,816 free bytes (about 71.2 GiB).
- Fixed future removal behavior: `model_manager.remove_tree` retries failed Windows tree deletions after clearing the read-only attribute. Fern uses it for managed model folders/caches, downloaded custom model cleanup, and Qwen Turbo model/source caches.
- Added a regression test that removes read-only model and OpenVINO cache blobs. The targeted model test passed; the full Python suite passed 96/96 outside the sandbox. `npm run typecheck`, Python `compileall`, and `npm run build` passed. Renderer UX passed 12/12, and the Electron integration smoke passed, including model add/remove and native dialog IPC. The sandboxed UX/Electron attempts initially hit `spawn EPERM`; rerunning with the permitted unsandboxed test context passed.
- Built local installer `Fern-Setup-0.1.36.exe`, 475,477,722 bytes, ProductVersion/FileVersion 0.1.36, SHA-256 `3AC72569F0969EF4378D19A7CE1A78BAD14C7BAA148E00EBA144C7CC6841EF63`. Authenticode reports `NotSigned`. It was not launched or published; the installed app remains 0.1.34 pending version-specific GUI installation approval.

### Installed Electron voice-clone GPU smoke test and exact issue #1 path check — 2026-10-25

- In the installed 0.1.34 Electron app, started a new Audio thread, selected Voice Clone · 0.6B, and attached the existing Fern-generated 5.0-second WAV through the native file picker by entering its path and pressing Enter. Fern accepted the 0.2 MB clip and enabled Generate speech.
- Generated “This is a short Fern voice cloning smoke test.” The UI completed in 92.1 seconds and saved a 2.9-second take. Its card says `Voice clone · 0.6B · Intel GPU`; playback was started and the control changed to Pause. No model or installer was downloaded, and CPU inference was not used.
- Preferences still shows `Allow CPU selection` disabled, CPU hidden, and Intel GPU selected. Models → Audio reports Custom Voice 0.6B/1.7B and Voice Clone 0.6B installed; Voice Clone 1.7B and Voice Design 1.7B are not installed. No additional downloads were started.
- Correction to the earlier issue #1 availability statements: the issue body puts the four reporter exports under `D:\Ai\openvino.genai\samples\python\image_generation\model\`, but the current PowerShell session reports that drive `D:` does not exist. The exact-folder checks therefore could not run in this session. Do not interpret the earlier direct-child path check as evidence that the four folders are absent; their availability remains unverified here.

### Fern 0.1.36 local Electron GUI audit — 2026-10-25

- Launched the built source Electron app (`apps/desktop/out/main/index.js`) visibly with the existing Fern Electron profile, then used mouse input in the app to inspect Models and Preferences. The default sandboxed Electron launch fails before rendering because Chromium cannot set its profile ACLs; launching the same local build in the permitted test context rendered normally.
- The source build uses `FERN_ROOT` both to locate its Python API script and as its data root. Pointing it at the installed profile therefore looks for `studio-data/scripts/api_server.py` and leaves the UI at “Connecting to Fern…”. Launching with the repo root restores the API and Models view, but reads repo-local `models` instead of the installed profile's `studio-data/models`. This audit did not copy, download, or remove any model files.
- Preferences in the visible 0.1.36 source app shows `Allow CPU selection` off, CPU hidden, Intel GPU selected, and OpenVINO · Intel GPU as the backend. The current 9B model is missing in the repo-local model root, so no image inference was started.
- Models → Image, Text, and Audio panes all opened. Image inventory reports the existing repo-local FLUX.3 export as runtime-ready and Tame Pony INT8 as installed; FLUX.3 inference was deliberately not run, and Tame Pony was not retested. Text lists Qwen3 4B as not installed; Audio lists its five Qwen3-TTS entries as not installed in the repo-local root. No install, delete, or model download action was taken.
- Installed-profile GPU TTS and voice-clone behavior is covered by the 0.1.34 visible Electron runs above. This source GUI audit does not substitute for the pending 0.1.36 installer upgrade and its installed-app check; no 0.1.36 installer was launched.

### Fern 0.1.36 source-root fix, Electron smoke, and installed-profile generation — 2026-10-25

- Fixed the dev-build path split in `apps/desktop/src/main/paths.ts`: the API/bootstrap scripts now resolve from the source tree by walking upward from Electron's compiled app path, while `FERN_ROOT` continues to point at the selected user-data/model profile. This lets a local build use the installed profile without copying models or looking for Python scripts inside `studio-data`.
- Updated `apps/desktop/e2e/smoke.mjs` to give the Electron smoke a separate scratch data root. The first run caught the incorrect source-root assumption; after replacing it with the ancestor search, `npm run test:electron --workspace @fern/desktop` passed, including API/preload startup, multi-reference persistence, Models navigation, custom-model add/remove and dialog IPC, model selection, cancel flow, and source preservation. `npm run typecheck` also passed.
- Relaunched the rebuilt source Electron app visibly against the existing installed profile. The existing `flux2-klein-9b-circulus-int4` remained available, so no model download or profile migration was needed. Preferences showed CPU selection disabled and the available Intel GPU selected.
- Ran one 512×512, one-image, 4-step smoke prompt (`A red cube on a plain gray background`) through the app. Activity recorded the job queued on Intel GPU, loading the FLUX.2 Klein pipeline on GPU, OpenVINO pipeline ready, steps 1/4 through 4/4, and completion in 74.9 seconds. The rendered preview is a red cube on a gray background. No CPU inference occurred and no model files were downloaded or deleted.
- This source-root change is development launch plumbing; it does not change packaged production path resolution. The installed app remains 0.1.34. The public latest release remains 0.1.29, and no stale public installer or unapproved local installer was launched.
- Opened the finished render's Render info panel in the Electron UI. It shows seed `994286815`, 4 steps, 1m 15s, 512×512, guidance 1, Device `Intel GPU`, model `flux2-klein-9b-circulus-int4`, revision `local-custom`, and path `models/flux2_klein_9b_circulus-int4`.

### Current working-tree verification refresh — 2026-10-25

- Ran `npm run check` using the repository `.venv` Python rather than the global Windows Python. TypeScript typecheck, Python compileall, all 96 Python unit tests, and the Electron production build passed. A first sandboxed attempt lacked `defusedxml`; rerunning with the repo venv exposed a sandbox-only multiprocessing pipe denial, then the exact check passed when allowed to launch its worker.
- Ran the renderer UX suite. The first restricted attempt could not launch Chrome (`spawn EPERM`). The first permitted full run passed 11/12; `ux-polish.mjs` timed out while navigating to the local renderer, then passed alone through the project's runner. A clean permitted full rerun passed all 12/12 renderer checks, including model selection/install/pause/resume, multi-reference workflows, text, performance scaling (100 and 1,000 images), and the full UX workflow.
- The app remains version 0.1.36. These checks built the local Electron app but did not create or publish a new public release. The existing issue/release status above is unchanged.

### Current local verification and release freshness refresh — 2026-10-25

- Refreshed the current public release page: `/releases/latest` still redirects to tag `v0.1.29` (released 2026-10-22). This confirms the public release is behind the local 0.1.36 tree. No stale public installer was installed and no release was published.
- On the current working tree, `npm run check` passed with the repo `.venv`: TypeScript, Python compileall, 96/96 Python unit tests, and the Electron production bundle.
- `npm run test:ui` passed 12/12 renderer checks on a clean rerun with installed Chrome. A first run had one 10-second page navigation timeout in `ux-polish`; the targeted runner retry passed, and the subsequent full rerun passed.
- `npm run test:electron --workspace @fern/desktop` passed on the current source. It verified the Electron main window, real preload/API bridge, multi-reference persistence, Models navigation, family/repository controls, dialog IPC, local model add/remove, model selection, cancellation, and source preservation. The isolated profile contained no model weights.
- A redundant installer rebuild was stopped during slow archive recompression: this turn's `paths.ts` fix changes source/dev resolution only, while the packaged branch still uses packaged resource and user-data paths. The existing local 0.1.36 installer (475,477,722 bytes) and prior valid runtime archive remain intact; the temporary partial ZIP was removed. No installer was launched in this step.

### Issue #6 LoRA integration boundary recheck — 2026-10-25

- Inspected the exact installed `optimum-intel==1.27.0.dev0+7234214` source used by Fern. `OVFlux2KleinPipeline.load_lora_weights` delegates to `transformer.load_lora_adapter`, but its OpenVINO `OVModelTransformer` has no `load_lora_adapter` or other adapter/LoRA method. This rules out simply surfacing the inherited Diffusers loader as Fern UI support.
- The OpenVINO GenAI LoRA guide now documents image-generation LoRA support, but support is export-specific. Fern's prior GPU probe using the existing Klein 4B export reached the GenAI adapter path and failed because `hidden_states.9` is not an input in that IR. Thus the current export cannot be advertised as LoRA-compatible via either available path; this needs an adapter-capable Klein export/runtime mapping before adding UI controls.
- No weights, adapters, models, or app data were downloaded, changed, or removed during this recheck. Sources: [OpenVINO GenAI LoRA guide](https://openvinotoolkit.github.io/openvino.genai/docs/guides/lora-adapters/) and [Optimum Intel OpenVINO pipeline source](https://github.com/huggingface/optimum-intel/blob/main/optimum/intel/openvino/modeling_diffusion.py).

### Live 0.1.36 source Electron Models and Preferences UI check — 2026-10-25

- In the visible source Electron app with the existing profile, opened Models and confirmed Klein 4B/9B report `Installed · OpenVINO runtime ready`; linked Klein exports, the installed SD 1.5 export, and Juggernaut XL are present. FLUX.3 and Qwen Image 2.1 Turbo report `Not installed`. No install/remove action was taken.
- Expanded Add custom model. The family selector lists Stable Diffusion 1.x/2.x, SDXL, Stable Diffusion 3, FLUX.1, and FLUX.2 Klein. Selecting FLUX.2 Klein changes only the form; Download remains disabled with an empty repository. Opened Add local folder and canceled the native folder picker without selecting a path; no registry or model files changed.
- Preferences explicitly states CPU is hidden and cannot be selected; `Allow CPU selection` is off, the active model is the existing local Klein 9B, and Device/Backend show Intel GPU. This was a UI inspection only; no inference, model download, install, or removal occurred.

### Fern 0.1.36 source Electron Qwen3 GPU text smoke — 2026-10-25

- In the visible source Electron app, created a Text thread and selected the already installed Qwen3 4B Instruct 2507 model. The composer showed no per-request CPU/device selector. Sent `Reply with exactly: Fern 0.1.36 source-build Qwen3 GPU smoke passed.`; the app returned the exact text.
- Expanded Response details: model `Qwen3 4B Instruct 2507`, device `GPU`, 29 input / 19 output tokens, 6.5 tokens/s, 2.9 seconds, temperature 0.7, top-p 0.9, seed 156735800, max tokens 512. The shared Preferences state remains CPU selection off and Intel GPU available. No model download or CPU inference occurred.

### Fern 0.1.36 source Electron Qwen3-TTS GPU smoke — 2026-10-25

- Reused the existing Qwen3-TTS 0.6B Custom Voice model in a new visible-app Audio thread; the model reported Ready before the run. Selected Preset voice (Vivian) and generated `Fern local GPU audio smoke.`.
- The progress UI showed `Loading speech runtime for GPU`, then `Compiling voice model and speech tokenizer on GPU`, then `Generating speech tokens on GPU`. It completed in 76.4 seconds and saved 3.1 seconds of audio. The take card reports `Preset voice · 0.6B · Intel GPU · Generated in 1:16 · Vivian`. Playback started and advanced to 2.6 seconds with the control changed to Pause.
- No model download/setup, file picker, cleanup, or CPU inference occurred. This checks the source-build audio workspace and runtime using the existing profile/model.

### Storage check after source-build GPU coverage — 2026-10-25

- C: had 71.1 GiB free after the source-build image, text, and audio runs. No model was downloaded or removed during this pass. Largest existing profile folders: Klein 9B 18.2 GiB, Klein 4B 8.7 GiB, Qwen3-TTS 8.0 GiB, custom image exports 5.4 GiB, Tame Pony SDXL 4.2 GiB, text models 3.8 GiB, and Tame Pony INT8 3.3 GiB.

### Fern 0.1.36 source Electron Qwen3-TTS Voice Design GPU smoke — 2026-10-25

- Used the visible Electron Models → Audio page to install only Voice Design · 1.7B. The UI showed the local speech environment preparation and per-file download progress, then marked the model Installed. Its 25-file OpenVINO export totals 4,196,233,926 bytes. Existing TTS models were reused and left intact.
- Created a new Audio thread through the New thread menu, selected Design a voice, entered a short script and voice description, and generated a take. The first-run status explicitly showed `Compiling voice model and speech tokenizer on GPU`. It completed in 52.0 seconds and saved 3.6 seconds of audio; the take card reports `Voice design · 1.7B · Intel GPU`.
- Played the take through the in-app player. The seek position advanced from 0 to 3.5 seconds of 4 seconds and the control changed to Pause during playback. No CPU inference or app reinstall occurred. This is source-build GUI coverage; the 0.1.36 installed-app upgrade is still pending action-time installer approval.
- After installation, C: had 67.2 GiB free. Voice Design is about 4.2 GB, below the user-set large-model cleanup threshold, so it remains installed for future tests.

### Fern 0.1.36 source Electron Qwen3-TTS Voice Clone 1.7B GPU smoke — 2026-10-25

- Installed Voice Clone · 1.7B from Models → Audio in the visible source Electron app. Fern prepared the local speech environment, reported download progress for model files, verified the downloaded OpenVINO XML, and marked it Installed. Its 27-file export totals 4,220,512,092 bytes. Voice Design 1.7B and all existing TTS models were retained; no app rebuild or reinstall occurred.
- Created a new Audio thread, selected Clone a voice and 1.7B, and attached the existing Fern-generated 0.2 MB WAV (`qwen3-tts-1792957656924.wav`) through the native file picker. Entered `Fern voice clone 1.7B GPU UI smoke test.` and generated a take.
- The runtime status explicitly said it was compiling the voice model and tokenizer on GPU, then decoding the audio waveform. The job completed in 65.8 seconds with a 4.9-second take. The take card shows `Voice clone · 1.7B · Intel GPU · Generated in 1:06`. Playback advanced to 4.6 seconds of 4.9 seconds and the button showed Pause.
- After both new TTS installs, C: had 63.2 GiB free. The Voice Design and Voice Clone 1.7B folders use 3.91 GiB and 3.93 GiB respectively; both remain installed because they are well below the large-model cleanup threshold.

### Fern release and GitHub issue state recheck — 2026-10-25

- GitHub `releases/latest` still redirects to v0.1.29, published Oct 22. This predates the local 0.1.36 source build and its installed-app upgrade remains pending explicit approval for the 0.1.36 installer.
- Fresh repository search returns the same four open issues: #1 custom OpenVINO model imports, #2 FLUX.3 setup, #6 FLUX.2 Klein 4B LoRA, and #7 the `rupeshs/flux3-image-klein-int4-ov` model request. Fresh comment fetches show no new comments on #2, #6, or #7. Issue #1 still has three comments; the latest reporter comment links the already tested `OpenVINO/Juggernaut-XL-v9-int8-ov` export. The exact four local directories from the original report remain unavailable on this PC.
- No public GitHub comments, issue states, labels, releases, or pull requests were changed. FLUX.3 remains uninstalled and untested, as directed. Issue #6 remains unimplemented while the tested Klein IR rejects the available adapters at `hidden_states.9`; do not expose a LoRA UI until a compatible export/runtime path passes GPU inference.

### Fern 0.1.36 installed Electron upgrade and GPU runtime check — 2026-10-25

- Correction to the preceding installer-status entries: after the user approved it, the verified local `Fern-Setup-0.1.36.exe` was run through Windows UI and upgraded the installed app from 0.1.34. Installed `Fern.exe` reports ProductVersion `0.1.36.0` and FileVersion `0.1.36`. SHA-256 is `3AC72569F0969EF4378D19A7CE1A78BAD14C7BAA148E00EBA144C7CC6841EF63`.
- The first post-install launch was redirected to the already-running source-build instance because both share Fern's single-instance profile. Closed the idle source window through its UI and launched `Fern.exe` from Explorer. The installed Electron window opened from `resources/app.asar/out/renderer/index.html` and reused existing profile/model data.
- Installed Models UI read the shared image inventory and correctly showed Klein 4B/9B runtime-ready, existing SD/SDXL and linked Klein exports present, FLUX.3 and Qwen Image 2.1 Turbo not installed. The Text tab reported Qwen3 4B Instruct 2507 installed at the existing shared `studio-data/models/text/qwen3-4b-instruct-2507-openvino` path. No model download or cleanup occurred in this installed-app pass.
- In the installed app, sent `Reply exactly: Installed Fern 0.1.36 Qwen3 GPU test passed.` using Qwen3 4B. It returned the exact response. Response details show `GPU`, 27 input / 17 output tokens, 6.3 tokens/s, and 2.7 seconds.
- Installed-app Preferences reports `Allow CPU selection` off, CPU hidden and unavailable, and Intel GPU selected with OpenVINO · Optimum Intel ready. The image/text/audio compute preference is shared. CPU inference did not run.
- No release was published. The public latest release remains v0.1.29. The unsigned installer was not modified; installed-app testing made no new installer build or download.

### Fern 0.1.36 release candidate verification — 2026-10-25

- `npm run test:electron --workspace @fern/desktop` passed against the current source tree, including the real preload/API bridge, multi-reference persistence, model controls, dialog IPC, cancellation, and source preservation. `npm run test:ui` passed 12/12 renderer workflows. With `.venv-release` first on `PATH`, `npm run check` passed TypeScript, Python compileall, 96/96 Python unit tests, and the production Electron build; `.venv-release` also passed `pip check`.
- `npm run package` rebuilt the self-contained Python runtime and Windows NSIS installer. The packaged runtime verified Python 3.12.1, OpenVINO 2026.4.1, OpenVINO GenAI 2026.4.1.0, Optimum Intel 1.27.0.dev0+7234214, and Torch 2.14.1+cpu (runtime package only). The runtime archive contains 27,871 files, is 385,179,867 bytes, and has SHA-256 `2087e2cd1f474d1f1814673cca38d3494d00c111c0779e577923800fe9d31b69`.
- Packaged-app `apps/desktop/e2e/smoke.mjs` passed against `release/win-unpacked/Fern.exe` with exit code 0 using an isolated profile. The installer is `Fern-Setup-0.1.36.exe`, 475,477,908 bytes, ProductVersion/FileVersion 0.1.36, SHA-256 `E4497B3A58E4EC548787A1FCB5507E16A9F8F896A08A0F53E44A9C1FCE0B2950`.
- This release build did not download or remove any model. C: had about 60.65 GiB free after packaging. The installed-app GUI/model verification is recorded in the preceding 0.1.36 installed Electron section.
