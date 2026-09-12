# Optional Klein 4B and automatic model selection

Planning only — September 12, 2026. No application changes made.

## Product policy

For a fresh installation, recommend 9B when the selected usable GPU meets a measured 9B memory envelope; offer 4B as an optional smaller model. Recommend 4B when it meets that envelope and 9B does not. Automatically choose the recommendation in setup, but show download size and allow Browse without installing. Do not silently download either model just because the app opens.

Existing installations keep their current 9B installation, profile, threads, and settings. Offer optional 4B in Preferences > Models. Do not switch an existing thread's explicit model choice after an upgrade or hardware change.

| Capability | Recommended install | Optional action |
| --- | --- | --- |
| GPU supports tested 9B workload | 9B | Install 4B too |
| GPU supports tested 4B workload only | 4B | Explain why 9B is not recommended |
| CPU only | Evaluate 4B CPU support and RAM first | Explicit slower CPU option, after validation |
| Device/runtime support unknown | Checking or compatibility unknown | Browse Library; retry detection |
| Neither fits | No automatic install | Browse Library; explain limits |

## Separate model and device selection

Model preference: Auto / Klein 9B / Klein 4B. Device preference remains Auto / Intel GPU / NVIDIA GPU / CPU. Auto resolves a model-device pair from usable backends and installed, compatible models. GPU vendor alone is not enough: a detected NVIDIA card without a working OpenVINO NVIDIA plugin is not a runnable candidate.

Auto should prefer 9B on a qualified GPU when installed; otherwise use installed 4B when compatible. When only 4B is installed on a 9B-capable machine, generate with 4B and offer 9B installation separately. Pin the resolved pair, revision and settings when a job is submitted, including all images in a batch. Never change an explicit choice silently or switch models halfway through a batch.

Display the resolved model beside Auto so the user knows what will generate. A failed 9B attempt can offer Retry with 4B, retaining prompt/reference/settings and adjusting only unsupported settings with a visible explanation. Avoid repeated automatic retries or downloading a fallback after an error.

## Hardware qualification

Gather usable backend/device, dedicated versus shared GPU memory, available system RAM, driver/runtime versions and free disk space. Treat integrated GPU memory as shared system memory, not as the small dedicated-memory figure reported by some Windows tools. Leave operating-system and application headroom.

Do not invent VRAM cutoffs from parameter count, checkpoint disk size or another implementation's published requirements. Benchmark the exact packaged exports and runtime: cold model load, warm generation, image editing, supported resolutions, and batch behavior. Measure peak RAM/VRAM as well as latency. A device can support 9B at one resolution but not another; check the requested workload again at submission.

Qualification states: checking, recommended, limited, unsupported, unknown. Persist measured compatibility keyed by model revision, runtime version, device and driver version. Invalidate after relevant changes. Runtime checks must remain bounded and independent of gallery and storage responses. Optional deep tests run only on request or first generation, not on every launch.

## Installation and state

Use one bundled runtime for both models only after verifying that it supports both actual exports. Each model gets an isolated install directory and manifest. Do not assume compatible tokenizers, text encoders or VAE files can be shared.

Model states: not installed, queued, downloading, paused, verifying, installed, repair needed, removing, failed. Keep these separate from runtime installation, backend connection, hardware compatibility, and model loaded/loading state. Installed files remain installed after stopping a job or unloading the worker.

Downloads need progress with byte totals, cancellation, resume, disk-space checks, error recovery, and a revision-pinned manifest. Download into staging and publish the install only after required assets, expected sizes/checksums and configuration are verified. File existence alone is insufficient. Account for temporary files and cache as well as final model size. Preserve the working model if another install fails.

Model removal removes only that model and its owned compiled caches. Keep images, prompts, references and render metadata. Block removal while a job uses the model; release it first when idle. Old images remain reviewable even when their model is no longer installed.

## UI

- Setup: compact Recommended model card, actual download size, short reason, Install and Browse library actions.
- Preferences > Models: 9B and 4B cards with Installed/Download/Resume/Repair/Remove actions. Explain compatibility here rather than widening device menus.
- Composer or image settings: compact model selector with Auto and resolved model. Installation actions open model management rather than starting hidden downloads.
- Render Info: actual model, revision, quantization and device used for that image.
- Thread restoration: retain model preference. Selecting an old image shows its original model; reusing generation settings restores the original model when installed and clearly offers alternatives when missing.
- Downloads/detection never hide the gallery, disable thread navigation or replace persisted drafts.

## Implementation map

1. Introduce a shared model catalog with stable ids, repository/revision, folder, required assets, pipeline type, defaults, limits and verified reference-image support.
2. Replace 9B constants in scripts/bootstrap_install.py, scripts/flux2_klein_pipeline.py and Electron first-run checks with catalog lookups. Preserve the existing 9B folder as a recognized legacy install.
3. Add a model installer/status service and background capability service. Invalidate cached model availability after install/remove/repair without requiring an app restart.
4. Extend generation payloads and worker cache keys with model identity and revision. Release the previous loaded model before loading another on memory-constrained devices. Preserve stop behavior during model loading and rendering.
5. Persist model preference per thread, resolved model per job, and actual model identity/revision in gallery metadata. Migrate existing records to 9B where provenance is known; retain unknown provenance instead of relabeling imports.
6. Update setup, model management, selection and render metadata UI; preserve the fixed profile/data-root selection.

## Delivery sequence and acceptance

Phase 1: Confirm the user's exact 4B repository/export, required files, revision, access and redistribution requirements; run text-to-image, image-edit and cancellation compatibility checks with Fern's bundled runtime. Record measured resource envelopes.

Phase 2: Implement explicit 9B/4B installation and selection first. Verify coexistence and switching before enabling automatic recommendations.

Phase 3: Enable Auto selection from the measured capability matrix, with conservative unknown states and user overrides.

Release checks: existing 9B-only upgrade; clean install; both models installed; 4B-only device; integrated shared-memory GPU; detected NVIDIA without usable plugin; CPU-only; low disk; interrupted/corrupt download; offline restart; stop during load; switching models; uninstall and reinstall; old image review; persisted thread restoration. Gallery and storage must remain accessible throughout. Test on real hardware, not only mocked status responses.

## Still needed

Exact URL for the user's 4B repository, whether it is already an OpenVINO INT4 export, and representative devices for memory qualification. No reliable hardware thresholds or download sizes are claimed until these are verified.
