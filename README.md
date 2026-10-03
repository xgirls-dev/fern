# Fern

Fern is a private Windows image and audio studio for running **Flux.2 Klein 9B** locally
with one shared image model and a hardware-specific OpenVINO device. Intel, NVIDIA,
and CPU execution all use the same xgirls INT4 OpenVINO release at
[`xgirls/FLUX.2-klein-9B-ov-int4`](https://huggingface.co/xgirls/FLUX.2-klein-9B-ov-int4).
NVIDIA execution uses the `NVIDIA` device from the
[OpenVINO NVIDIA plugin](https://github.com/openvinotoolkit/openvino_contrib/tree/master/modules/nvidia_plugin).

Fern also provides audio threads for **Qwen3-TTS with OpenVINO**. Audio threads keep speech settings and WAV outputs separate
from image threads. The Qwen3-TTS workspace supports preset voices, voice
design, and reference-audio voice cloning. **Set up** installs a pinned speech
runtime and downloads the selected ready-made OpenVINO export from
[xgirls on Hugging Face](https://huggingface.co/xgirls). New installations do
not export source checkpoints. Downloads are verified and can resume after
interruption; the first take still compiles the downloaded model on the GPU.

The app supports text-to-image and image-guided generation, a local gallery,
repeatable seeds, batch generation, and CPU, Intel GPU, or NVIDIA GPU execution. Prompts,
reference images, and generated images stay on the local machine.

Use **New image thread** (Ctrl+N) to start an image workspace, or **New audio thread** (Ctrl+Shift+N) for speech. Threads in the sidebar
keep their own prompt, settings, reference image, and generated images across
app restarts. Select a thread to continue it, or open **Library** to browse all
images. Images appear as large thumbnails in the main workspace.

## Install

Download `Fern-Setup-*.exe` from the project's GitHub Releases
page and run it. The installer contains the desktop app, Python, OpenVINO, and
the OpenVINO NVIDIA plugin when included in the build environment. On first
launch, Fern installs its bundled runtime. Optional Klein 4B/9B models can be
downloaded from Preferences; Qwen3-TTS models are downloaded from the audio workspace. On
hybrid laptops with both Intel integrated graphics and an NVIDIA GPU,
Auto-select gives the NVIDIA GPU priority when the NVIDIA driver reports it.
If the NVIDIA plugin is not ready, Fern reports that directly instead of
silently switching to the Intel GPU.
After the model is available, Fern loads it into the selected device memory
before enabling generation; the first runtime load can take a little while.
During generation, use **Stop Generation** to cancel at the next inference
step without closing the app.

Requirements:

- Windows 10 or 11, 64-bit
- Approximately 12 GB of free disk space for the shared OpenVINO model
- An internet connection for the first model download
- An Intel GPU supported by OpenVINO, an NVIDIA GPU with a current driver and
  compatible CUDA libraries, or a CPU fallback
- NVIDIA support requires the OpenVINO NVIDIA plugin from `openvino_contrib`,
  built against the same OpenVINO runtime as Fern. The upstream plugin currently
  documents Ubuntu validation; Windows builds must use its Windows/CMake path.

The installer does not require a separate Python, Node.js, Git, or terminal
installation.

## Local data and cache management

Open **Data** in the Fern title bar to review disk usage, clear the compiled
generation cache, or reset local creative data. A local-data reset removes
generated images and WAV takes, thread/gallery metadata, saved prompts, and preferences while
preserving downloaded models and bundled runtimes.

Fern automatically prunes generation-cache files that have not been
used for 30 days. The cache is also limited dynamically between 1 GiB and 40 GiB
based on drive capacity, with a disk-relative free-space reserve of 5–20 GB.
Generated images and WAV takes are never deleted automatically.

## Development

This repository is an npm workspace. The Electron app lives in `apps/desktop`;
the Python backend and packaging tools live in `scripts`.

Prerequisites:

- Node.js 22 or newer
- Python 3.12
- PowerShell 7 (Windows PowerShell 5.1 also works for the provided scripts)

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm run dev
```

`npm run dev` launches the Electron UI directly from source; it does not need
a release build or the bundled runtime archive. Development uses the local
`.venv` and opens the UI even when the model has not been downloaded yet. To
enable generation in development, download the model into the `models/`
directory with the bootstrap command below, then relaunch the app.

The development app expects the model at:

```text
models/flux2-klein-9b-circulus-int4
```

Download it with the same bootstrap used by the installer:

```powershell
.\.venv\Scripts\python.exe scripts\bootstrap_install.py `
  --model-dir models\flux2-klein-9b-circulus-int4
```

To build and install the OpenVINO NVIDIA plugin from the linked upstream source:

```powershell
.\scripts\install-openvino-nvidia-plugin.ps1
```

Then prepare the shared model for NVIDIA execution:

```powershell
.\.venv\Scripts\python.exe scripts\bootstrap_install.py `
  --adapter nvidia `
  --models-root models
```

The NVIDIA adapter calls `OVFlux2KleinPipeline.from_pretrained` with
`device="NVIDIA"`; Intel uses `device="GPU"`, and CPU uses `device="CPU"`.
Fern also keeps an explicit CPU option in the Device menu.

Useful commands:

```powershell
npm run typecheck
npm run build
npm run check:python
npm run check
```

Generated models, virtual environments, images, caches, bundled runtimes, and
installers are ignored by Git and must not be committed.

## Build the one-click installer

Prepare a clean build environment, keeping model experiment dependencies separate:

```powershell
python -m venv .venv-release
.\.venv-release\Scripts\python.exe -m pip install -r requirements-release.txt
npm run package
```

The build uses `.venv-release` when present, otherwise `.venv`, and rejects retired
Qwen Image dependencies or an Optimum Intel checkout that does not match
the locked `requirements-release.txt`. An explicit environment can be selected with
`scripts/build-installer.ps1 -SourceVenv <folder>`. Build the optional NVIDIA plugin
against that same environment before packaging if NVIDIA support is required.
The build script creates a self-contained runtime and writes the one-click NSIS
installer to `apps/desktop/release/`. Image and speech model weights are not embedded;
they download on demand from Hugging Face.

The runtime builder detects the base Python installation used by the selected environment. You
can override it when needed:

```powershell
.\scripts\bundle-python-runtime.ps1 -PythonHome "C:\Path\To\Python312"
```

## Repository layout

```text
apps/desktop/   Electron + React desktop app
scripts/        Flux.2 Klein 9B backend, setup, and packaging tools
.github/        CI and contribution templates
```

## Security and privacy

The API binds to `127.0.0.1` and accepts generation requests only from the local
desktop app. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By design, changes that add another
model family or checkpoint selector are outside this project's scope.

## License

MIT. See [LICENSE](LICENSE).


The retired Qwen Image 2.1 attempts, self-contained recreation instructions, and removal record are documented in [the experiment report](docs/experiments/QWEN-IMAGE-2.1-EXPERIMENT-REPORT.md).
