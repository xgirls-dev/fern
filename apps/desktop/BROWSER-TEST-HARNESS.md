# Browser test harness

Fern's browser test page mounts the same React `App` used by Electron and supplies a browser implementation of the preload bridge. Renderer requests still reach the real Fern API. Native window controls and operating-system file dialogs are browser-safe stubs.

The bundle is written to `.cache/fern-browser-test-dist`, outside the Electron package output.

## Real Electron smoke test

Run `npm.cmd run test:electron --workspace @fern/desktop` from the repository root. This builds and launches the actual Electron main process, preload, renderer, and Python API in a temporary profile. It uses Playwright's main-process dialog mock to exercise the real folder-picker IPC without opening an OS dialog, adds and removes a tiny valid OpenVINO SDXL fixture, verifies cancellation and source-file preservation, and fails on renderer or console errors. Temporary data and screenshots are removed after success and retained for debugging after failure.

The test needs the repository's `.venv`. It does not need a downloaded model, run inference, or download model files.

## Run it

In one PowerShell terminal, start the API with a temporary custom-model registry and Hugging Face cache:

```powershell
$env:FERN_CUSTOM_IMAGE_REGISTRY = Join-Path (Get-Location).Path '.cache\fern-browser-test-registry.json'
$env:HF_HOME = Join-Path (Get-Location).Path '.cache\hf-fern-browser-test'
& '.\.venv\Scripts\python.exe' 'scripts\api_server.py' --port 18743 --cors
```

In a second terminal, build and serve the browser bundle:

```powershell
npm.cmd run build:browser-test --workspace @fern/desktop
npm.cmd run preview:browser-test --workspace @fern/desktop
```

Open `http://127.0.0.1:5173/browser-test.html?api=http%3A%2F%2F127.0.0.1%3A18743` in a browser. The browser page exercises the real API, so model downloads are written to Fern's managed `models/custom-image-models` directory. Remove a test download through the model card when done; Fern then removes its managed files. A locally linked model is only unregistered and its source folder remains intact.

To exercise the local-folder picker flow without Electron, add a URL-encoded `customImageFolder` query parameter with a known export directory. The browser bridge returns that directory when the app opens its custom-model folder picker; Fern still validates and registers the directory through the real API. For example, use `?api=http%3A%2F%2F127.0.0.1%3A18743&customImageFolder=C%3A%5Cmodels%5Cmy-openvino-export`.
