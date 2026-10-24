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

The 30-step quality check used 512×512. The reported 1024×1024 workspace failure
is covered by the shared-root correction; a new 1024×1024 quality run was not
performed in this pass.

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
