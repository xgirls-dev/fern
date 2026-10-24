# Changelog

Notable changes to Fern are documented here. GitHub Releases publish the
matching version section below, so release notes remain useful even when work
lands directly on `main` instead of through labeled pull requests.

## [Unreleased]

## [0.1.30] - 2026-10-24

### Added

- Multiple reference images for FLUX.2 Klein 4B and 9B: attach up to four,
  reorder or remove them, and restore them with saved threads and variations.
- A dedicated Models page for image, text, and audio model installation,
  accessible from the sidebar, model menus, and command palette.

### Improved

- One New thread menu replaces the three separate creation buttons.
- Thread groups share one scrollbar while navigation and preferences remain reachable.
- Model menus use single-line rows with truncation for long names.
- Model cards use concise summaries with expandable technical details.
- CI and release checks run the renderer workflow and layout regressions.

### Fixed

- Packaged Pony generation uses Fern's writable workspace for output validation,
  model paths, and compilation caches.
- Pony's legacy EDM scheduler metadata is corrected at runtime to DPM++ 2M
  Karras for its SDXL epsilon denoiser, resolving noisy output.
- Reference attachments persist their owning thread and finish saving before
  appearing as attached, preventing loss on an immediate reload.
- Unsupported model switches preserve attachments and explain what needs to change.
- Client-side dimension checks use the selected model family's limits.
- Custom GenAI model families retain the pipeline they load.

Full Changelog: https://github.com/xgirls-dev/fern/compare/v0.1.29...v0.1.30

## [0.1.29] - 2026-10-22

### Added

- Custom OpenVINO image models can be downloaded from Hugging Face or linked
  from a local folder. Choose a supported model family and use the model from
  the image composer.
- A browser-based renderer harness and Electron smoke coverage for custom
  model installation, validation, selection, and removal.

### Improved

- Custom image models apply family-specific generation defaults and dimension
  limits in the composer.
- FLUX.3 Klein setup reports download and runtime progress, supports
  cancellation, and surfaces more useful setup errors.
- Generated image metadata includes the custom model name and family.

### Fixed

- Runtime readiness now corresponds to the image model selected in the current
  thread.
- SDXL model setup handles the current Diffusers device lookup API.
- Removing a linked local model preserves its source files.

Full Changelog: https://github.com/xgirls-dev/fern/compare/v0.1.28...v0.1.29

## [0.1.28] - 2026-10-20

### Added

- Local text threads with streaming responses, saved conversations, and Qwen3
  4B Instruct 2507 as the recommended OpenVINO model.
- FLUX.3 Klein and Tame Pony SDXL OpenVINO model integrations, including the
  Pony INT8 variant.
- Model-specific image controls and supported-size filtering, including
  Qwen Image 2.1 Turbo's 32-pixel dimension requirements.

### Improved

- Image, text, and audio workspace navigation, composers, model selection, and
  settings for a more consistent desktop workflow.
- Model installation, runtime checks, release packaging, and local workspace
  reliability.

### Fixed

- Qwen Turbo output handling for valid dimensions and generated-file metadata.
- Text-thread lifecycle, download validation, and cancellation edge cases.

Full Changelog: https://github.com/xgirls-dev/fern/compare/v0.1.27...v0.1.28
