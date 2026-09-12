# Klein 4B implementation — September 12, 2026

Implemented optional 4B/9B installation in Preferences, composer model selection, per-thread persistence, installed model/device Auto resolution, per-model caches, and actual model/revision render metadata. Existing threads default to their original 9B model. First-run setup installs only the shared runtime; model downloads and model loading do not block the gallery.

Downloads use pinned Hugging Face revisions, resumable byte ranges, staging directories, size checks, and SHA-256/Git blob checksums before publication. Users can pause/resume, remove partial downloads, and remove installed models without deleting images or threads. Damaged installations use explicit removal/reinstallation. Model files and their own compiled caches are the only removal targets.

Pinned repositories:
- xgirls/FLUX.2-klein-4B-ov-int4: f53967e707ab0a1ab795c5d0704b8c4f0e2f22c3; 4,580,585,470 download bytes.
- xgirls/FLUX.2-klein-9B-ov-int4: 74a4022819d82a0574a75ab138b4d908e85e6796; 9,624,762,465 download bytes. Existing older 9B exports remain recognized.

Verification:
- Entire 4B download verified in artifacts/model-verification.
- Real installed Windows Python/OpenVINO runtime, Intel GPU: 512 x 512 text-to-image and reference image editing, four steps each. Visually confirmed a red bowl became blue while retaining the scene.
- First text render: about 200 seconds including cold load, 54 seconds generating. Subsequent worker run: about 80 seconds including load, 46 seconds generating. Image edit: about 94 seconds. These are local observations, not general performance claims.
- The first bounded test cancelled during image editing; the longer bounded test completed both modes.
- Browser model selection, install/pause/resume controls and gallery navigation passed.
- Real existing-profile integration: 98 images visible, installed runtime detected, gallery survives reload without loading a model. User data was not moved or deleted.
- 31 Python tests and both TypeScript checks pass. Production build passes. Packaging tests check the new Python modules and model catalog JSON.

Hardware limits:
Auto prefers installed GPU-capable model/device pairs, including 4B GPU before 9B CPU. It rejects models whose weight size exceeds detected memory. Integrated GPUs use shared RAM information; discrete GPUs use reported device memory when available. Unknown capacity stays unmeasured. This is not a certified hardware matrix: peak RAM/VRAM requirements across resolutions, CPU performance and NVIDIA driver/plugin combinations need representative hardware measurements. Passing the weight-size check does not guarantee every workload fits. No model is silently downloaded or substituted during a batch; explicit choices stay explicit, with a 4B retry choice for 9B memory errors.

The export produces Optimum warnings about missing VAE scaling_factor configuration. Both tested generation modes completed correctly; retain this observation for future exports.

Paused progress resumes from actual partial files; its byte total is reconstructed on resume. Automatic in-place repair of a modified working model is not implemented; use explicit removal/reinstallation.

The verification model and outputs are isolated under artifacts/model-verification. The installed executable and original model directories have not been replaced. No release has been published.
