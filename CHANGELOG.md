# Changelog

Notable changes to Fern are documented here. GitHub Releases publish the
matching version section below, so release notes remain useful even when work
lands directly on `main` instead of through labeled pull requests.

## [Unreleased]

### Added

- Choose clips from 4 to 10 seconds with Wan 2.2 Turbo on Intel Vulkan. Longer renders show sampling and decoding progress and can be stopped.

### Improved

- Show measured prompt processing time and reused tokens in GGUF response details.
- Reuse the processed prompt across follow-ups in long GGUF chats when the retained history still fits.
- Show progress as a local GGUF model processes the chat prompt before its first reply token.

### Fixed

- Restart Fern’s local service from Video after an interruption. The first frame and motion prompt stay ready, and completed clips return from history.
- Finish stopping a chat even when its live stream misses the final update.
- Bring the selected Find match into view when a long reply finishes formatting.
- Find every generated image prompt in a chat reply, including saved versions, and jump to the matching image.
- Return focus to the composer when resending an edited earlier prompt. The editor explains which messages are saved in Versions.
- Keep the GGUF model loaded when Stop interrupts an in-progress chat summary after it starts generating text.
- Preserve an unsent inline prompt edit with its conversation version when switching versions.

## [0.1.49] - 2026-11-25

### Added

- Save workspace backups from Local data. Restore a backup into a separate workspace and switch back to the original with its chats and media.
- Open the model picker for the focused chat with Ctrl+Shift+L or Cmd+Shift+L on Mac. When opened from the composer, selecting a model or pressing Escape returns focus to the draft.
- Undo a message deletion with Ctrl+Z or Cmd+Z on Mac while the conversation or its Undo control has focus.
- Load or unload a chat model in Chat settings. Cancel a load while keeping the draft, or restart the local service from Chat after it exits.
- Open a document source at the passage sent to the model. Replace or remove a missing attachment and retry the original prompt.

### Improved

- Load the chat interface alongside saved history when reopening Fern.
- Mount fewer messages when switching to a long chat so the new draft appears sooner.
- Keep keyboard focus in the gallery after a bulk deletion, including when the last image is removed.
- Find text in saved conversation versions from Search threads. Open the matching message in a preview that keeps the active conversation intact.
- Show the full text of each received reply update immediately, so delayed animation callbacks cannot leave a reply stuck halfway through a chunk.
- Show when chat is checking hardware before it begins loading a GGUF model.
- Keep streaming replies free of animated dots. The composer shows when Fern is responding or waiting for more text.
- Use a monochrome Stop button in the composer. Escape also stops a reply while you are reading it in the conversation.
- Keep more of the conversation visible in short windows when the draft contains an image and documents.
- Reuse a completed GGUF context summary when a follow-up or fork sends the same earlier turns to the loaded model. Chat shows when summarization takes longer.
- Reuse the loaded Vulkan chat model when switching from an image conversation to plain text.
- Start Gemma 4 GGUF chat on Vulkan on Windows systems with the tested Intel Arc B390 adapter.

### Fixed

- Reopen Fern's window after a renderer crash while keeping the local service running. Windows users can launch with `--fern-software-rendering` if the window goes black during GPU inference.
- Restore the reading position in the first frame when showing a hidden chat pane.
- Keep the reading position when an earlier message changes height or when returning to a chat in a compact split pane.
- Recover a chat deletion or Undo when a reload interrupts saving the active transcript.
- Resume typing at the same caret after attaching a document. The chat composer shows when it can accept a document drop even if a conversation image is already selected.
- Keep Stop responsive while Fern reads a large chat document.
- Stop a GGUF load promptly when the model server is still starting.
- Use the GGUF engine to detect its own hardware and avoid a text worker startup stall on Windows.
- Load saved chat images once Fern connects to its local service when it reopens.
- Retry a GGUF chat on Vulkan when OpenVINO hits a GPU tensor-shape error before the reply begins.
- Restore the active image context when you remove newer turns that had replaced it.

Full changelog on [GitHub](https://github.com/xgirls-dev/fern/compare/v0.1.48...v0.1.49).

## [0.1.48] - 2026-11-20

### Added

- Open two chats side by side with independent drafts, attachments, and settings. Resize the panes, switch between them in narrow windows, and restore both after reopening Fern.
- Organize conversations into searchable nested folders. Edit earlier prompts, restore a previous conversation version, duplicate a chat, or fork from a specific message.
- Ask questions about local PDF, DOCX, TXT, and Markdown attachments. Fern keeps documents with the chat for follow-ups and shows the passages supplied to the model.

### Improved

- Configure image generation directly in Chat with model-specific dimensions, steps, guidance, seed, batch size, style, LoRAs, and references.
- Enter exact GGUF context length, maximum output length, Temperature, and Top P. Save per-model defaults and reusable Chat presets, and configure advanced sampling, Flash Attention, batching, and KV cache precision.

Full changelog on [GitHub](https://github.com/xgirls-dev/fern/compare/v0.1.47...v0.1.48).

## [0.1.47] - 2026-11-20

### Fixed

- Fix tiled-noise output with the Consistency V2 adapter on FLUX.2 Klein 9B. Fern applies enabled 9B adapters when compiling the Intel GPU model.
- Fix slow inference with rank-8 Klein LoRAs on Intel GPUs. Fern aligns adapter tensors for the optimized GPU operation while preserving the original weights.

Full changelog on [GitHub](https://github.com/xgirls-dev/fern/compare/v0.1.46...v0.1.47).

## [0.1.46] - 2026-11-20

### Fixed

- Remove the four-minute deadline for Intel Vulkan image generation. Render until completion, a runtime error, or cancellation with Stop.
- Choose portrait and landscape presets, custom dimensions, and step counts for Kromoss OPD · DMD2. The default remains 512 × 512 at eight steps.

### Documentation

- Add a [Windows Intel Iris Xe benchmark](https://github.com/xgirls-dev/fern/blob/main/benchmarks/v0.1.45-intel-iris-xe.md) covering first and repeated runs for image, video, and speech generation, plus multi-turn Gemma text and vision.

Full changelog on [GitHub](https://github.com/xgirls-dev/fern/compare/v0.1.45...v0.1.46).

## [0.1.45] - 2026-11-19

### Added

- Install **Kromoss OPD · DMD2** on Windows with a compatible Intel GPU. It uses the OPD 69,800 Q4_K weights and the matching eight-step adapter. Create Image defaults to 512 × 512 and also offers 1024 × 1024. Chat generates at 512 × 512.
- Install **SANA-Sprint**, **MOSS Image HaDeS**, and **Z-Image Turbo** from Models on Windows with a compatible Intel GPU. Fern downloads the pinned Vulkan runtime when needed.
- Animate a first frame with **Wan 2.2 Turbo** in the Video workspace on Windows with a compatible Intel GPU. Play clips in Fern or save them as WebM.
- Install **Gemma 4 E4B** or import local GGUF chat models. Attach images with a matching vision projector and switch between Instant and Reasoning on supported models.
- Generate images in Chat with a tool-capable vision model and an installed compatible image model. Fern inspects the result before replying and carries recent images into follow-up turns. Choose a 4K, 8K, or 16K chat context.
- Download the **Omarchy x86-64 beta** package with bundled Python and OpenVINO. The beta supports FLUX.2 Klein, GGUF chat and vision, and image generation in Chat.

Full changelog on [GitHub](https://github.com/xgirls-dev/fern/compare/v0.1.44...v0.1.45).

## [0.1.44] - 2026-11-17

### Added

- Install FLUX.2 Klein 9B · LoRA from Models for image generation and editing on Intel GPUs.
- Attach and reorder up to four reference images with either FLUX.2 Klein LoRA model.
- Keep separate LoRA selections for Klein 4B and 9B in each image thread.

### Fixed

- Load Klein adapters that mix Diffusers `.lora_A`/`.lora_B` and `.lora.down`/`.lora.up` tensor names.
- Reject incomplete `.safetensors` downloads and replace invalid cached copies after a verified download.

## [0.1.43] - 2026-11-12

### Added

- Download LoRA files from Hugging Face or Civitai links and add them to an image thread.
- Use a reference image with the LoRA-ready FLUX.2 Klein 4B model on Intel GPUs.
- Use the optional uncensored text encoder with either Klein 4B model from one shared download.
- Select and delete multiple images from the Library, with a confirmation before moving them to the Recycle Bin.

### Improved

- Refined the interface across model management, image settings, Library, text, audio, and preferences with consistent controls, spacing, and focus states.
- Made LoRA controls more compact and centered the model category tabs.

### Fixed

- Restore actual removal of managed model files when a model is removed.

The LoRA-ready model uses Intel GPUs and supports one reference image. Klein 9B LoRAs are not supported.

## [0.1.42] - 2026-11-11

### Added

- Optional OpenVINO INT4 uncensored Qwen3 text encoder for FLUX.2 Klein 4B, with in-app download, persistent enable toggle, and the stock encoder retained as the default.
- A separate LoRA-ready FLUX.2 Klein 4B model for Intel GPU text-to-image, with local safetensors selection, up to four independently enabled adapters, and adjustable strengths. Render information records the active adapters.

## [0.1.36] - 2026-10-25

### Added

- A dedicated Models page for installing and managing image, text, and audio models.
- Multiple reference images for FLUX.2 Klein 4B/9B with ordering, removal, and persistence across saved threads and variations.

### Improved

- GPU is the default compute path across image, text, and audio. CPU selection stays hidden unless explicitly enabled in Preferences, and generation settings no longer expose a per-render device selector.
- Qwen3-TTS GPU decoding uses a traced static speech-tokenizer shape; warm-pipeline progress is reported once per take.
- Custom FLUX.2 Klein OpenVINO exports use Optimum Intel's Diffusers adapter.
- Model management and composer workflows include clearer model details, family-specific generation limits, and more reliable reference and thread persistence.

### Fixed

- Model removal retries after clearing Windows read-only attributes, so OpenVINO compiled-cache blobs and Hugging Face exports can be removed cleanly.
- Custom image progress ignores callbacks beyond the configured step count. Pony generation uses Fern's writable workspace and corrected SDXL scheduler metadata.

Full Changelog: https://github.com/xgirls-dev/fern/compare/v0.1.29...v0.1.36

## [0.1.35] - 2026-10-25

### Fixed

- Qwen3-TTS decode progress is wrapped only once on a warm pipeline, preventing duplicate progress messages from accumulating across takes.

## [0.1.34] - 2026-10-25

### Improved

- GPU is the default compute path across image, text, and audio. CPU selection is hidden unless explicitly enabled in Preferences.
- GPU Qwen3-TTS decoding uses the traced static speech-tokenizer shape to avoid dynamic-shape stalls.
- Custom FLUX.2 Klein OpenVINO exports use Optimum Intel's Diffusers adapter.
- Custom image progress ignores a terminal callback beyond the configured step count.

### Fixed

- Image generation settings no longer expose a per-render device selector; the app uses the available GPU automatically.

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
