# Browser test harness

Fern's browser test page mounts the same React `App` used by Electron and supplies a browser implementation of the preload bridge. Renderer requests still reach the real Fern API. Native window controls and operating-system file dialogs are browser-safe stubs.

The bundle is written to `.cache/fern-browser-test-dist`, outside the Electron package output.

## Real Electron smoke test

Run `npm.cmd run test:electron --workspace @fern/desktop` from the repository root. This builds and launches the actual Electron main process, preload, renderer, and Python API in a temporary profile. The test window stays hidden using `FERN_E2E_HEADLESS=1`, so automation does not take focus from other work. It checks multiple reference attachments across reload, the Models page, real folder-picker IPC through a main-process dialog mock, local-model registration/removal, cancellation, and source-file preservation. Temporary profile data is removed after success and retained for debugging after failure. A Models screenshot is retained under `artifacts/ux-verification`.

The test needs the repository's `.venv`. It does not need a downloaded model, run inference, or download model files.

After building an installer, test the packaged executable and its bundled Python
runtime with a fresh profile:

```powershell
$env:FERN_E2E_EXECUTABLE = Join-Path (Get-Location).Path 'apps\desktop\release\win-unpacked\Fern.exe'
node apps/desktop/e2e/smoke.mjs
Remove-Item Env:FERN_E2E_EXECUTABLE
```

This additionally checks first-run runtime extraction and verifies that Electron
is running as a packaged application. Native page capture keeps the production
window hidden while taking screenshots.

Run `npm.cmd run test:ui` for the renderer regression suite. It uses mocked API
responses with the real React app and headless Chrome. Live inference scripts
are excluded. An installed Chrome or Edge is detected on Windows; set
`FERN_CHROME_PATH` to override it. Screenshots and results are written under
`artifacts/ux-verification`.

Model installation is now under **Models** in the sidebar. Image, text, and
audio installation use separate categories on that page. General Preferences
contains appearance, workspace, and runtime information.

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
