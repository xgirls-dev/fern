# Changelog

Notable changes to Fern are documented here. GitHub Releases publish the
matching version section below, so release notes remain useful even when work
lands directly on `main` instead of through labeled pull requests.

## [Unreleased]

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
