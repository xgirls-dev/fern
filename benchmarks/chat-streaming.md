# Chat streaming benchmark

The built renderer receives a deterministic model-status snapshot, 100 text updates, and a completed response over the same server-sent events client used by Fern. The fixture sends one update every 50 ms, mixes plain text, bold text, and Unicode, and finishes with a table and a JavaScript code block. No model download is needed.

## Run on a built checkout

From the repository root, install dependencies and Playwright Chromium, build the revision, and run the benchmark.

```sh
npm ci
npx playwright install chromium
npm run build
node benchmarks/chat-streaming.mjs > chat-streaming.json
```

Run the same replay in the source-built Electron window with a fresh temporary profile. Use `FERN_E2E_VISIBLE=1` for a visible window or omit it for hidden Electron. `FERN_BENCH_STREAM_SEND=enter` uses Enter in the composer. Click is the default.

```sh
FERN_E2E_VISIBLE=1 node benchmarks/chat-streaming.mjs electron > chat-streaming-electron.json
FERN_E2E_VISIBLE=1 FERN_BENCH_STREAM_SEND=enter node benchmarks/chat-streaming.mjs electron > chat-streaming-enter.json
```

Repeat with the same opener, window visibility, recorded viewport, browser, and machine load. The script verifies that all 100 updates appeared and that the completed Markdown table and code block rendered. Keep the revision and raw JSON when comparing runs.

Set `FERN_BENCH_STREAM_TRACE=1` for a diagnostic replay. The `trace` section records event receipt, DOM commit, the following render opportunity, Markdown worker round trips, and Chromium long tasks and animation frames where supported. The extra observers affect timing. Use ordinary replays for paired latency comparisons.

Set `FERN_BENCH_STREAM_CODE_LINES=350` to stress syntax coloring. This replay measures the formatted reply, the first colored code, the frame with all code lines colored, and the longest frame gap while colors arrive.

## Read the report

- **Send to first frame** measures the first frame opportunity after the click or Enter. **Send to reply commit** measures the first streaming row mutation in the DOM. **Send to feedback** measures the first frame with that row present.
- **Send to first event** measures Send to receipt of the first status snapshot. The fixture controls when that snapshot arrives.
- **First text receipt to frame** measures when the first incremental text arrives in the renderer and when it is first present in a render opportunity. The per-update samples use the same boundary for each of the 100 unique markers.
- **Terminal receipt to formatted frame** measures the completed event to the first frame with the settled reply, table, and code block.
- **Longest frame gap** measures all sampled animation frames from Send through final formatting. It includes the first frame after clicking.

The Chromium fixture exercises the production renderer and streaming client. Electron also uses the real desktop window, preload, and Python application startup. The model inventory, generation request, and stream remain deterministic fixtures in both modes. The browser frame is a proxy for presentation. Real model load, inference, packaged behavior, and display scanout need separate measurements.

## Renderer baseline at 495af8e

Three fresh headless Chromium runs on November 23, 2026 used an Intel Core i5-8210Y Mac with 8 GiB RAM. All 300 updates appeared and all three final replies rendered their table and code block.

| Measurement | Result |
| --- | ---: |
| Incremental receipt to frame, pooled p95 / max | 56 ms / 412 ms |
| First text receipt to frame, range | 15–33 ms |
| Send click to reply-in-progress frame, range | 154–344 ms |
| Terminal receipt to formatted reply, range | 59–258 ms |

The incremental p95 is below the roadmap's 100 ms streaming target on this fixture. The Send row and the tail of final formatting were measured separately in the visible native window.

## Visible Electron baseline

Three fresh source-built Electron 43.2 runs per opener on the same Intel Mac used an actual content size of **1440 × 804** at 2× device scale. The requested height was 920. Each opener supplied 300 text updates across its three runs.

| Measurement | Click | Enter |
| --- | ---: | ---: |
| Reply commit after Send, range | 24–50 ms | 21–31 ms |
| Reply-in-progress frame after Send, range | 33–68 ms | 44–47 ms |
| Incremental receipt to frame, pooled p95 / max | 46 ms / 450 ms | 68 ms / 219 ms |
| Terminal receipt to formatted reply, range | 21–93 ms | 19–42 ms |

In all six runs the reply appeared on the first available frame after Send. The incremental p95 met the 100 ms target in this replay. The longest update delays still require investigation.

## Collect a real GGUF trace

Use the packaged Windows Intel GPU smoke test with the Gemma 4 E4B catalog files. From the repository root after `npm ci`, point `FERN_E2E_EXECUTABLE` at the tested build. Optionally point `FERN_E2E_TEXT_MODEL_ROOT` at an existing catalog model directory to reuse its model files.

```powershell
$env:FERN_E2E_EXECUTABLE = Resolve-Path 'apps/desktop/release/win-unpacked/Fern.exe'
node apps/desktop/e2e/gguf-smoke.mjs
```

The report in `artifacts/release-test/gemma-4-e4b-gguf.json` records text and vision with Instant and Reasoning modes. Keep the package revision, hardware, and driver alongside the report. The smoke test verifies these journeys. Use repeated matched text-only runs for a performance comparison.

- `rendererTiming` reports Send to the reply row, the first status event, the first answer text received over SSE, the first frame with answer text, the terminal event, and the settled reply frame. It also records the longest gap between frame opportunities. An unavailable SSE measurement is `null`. Frame callbacks are a presentation proxy.
- `runtimeTiming` reports conversation preparation and receipt of the first output chunk by Fern's worker. A reasoning or tool chunk can arrive before answer text. When the model loads, `runtimeSetupMs` measures runtime provisioning and validation, and `modelReadyMs` measures GGUF server initialization through readiness.
- `prefillMs`, `decodeMs`, `evaluatedPromptTokens`, and `cachedPromptTokens` come from the engine's final response when available. `generationSeconds` retains its existing request-to-terminal meaning. The model-load fields only accompany a new load, and the engine fields describe one model call. [Pinned llama.cpp timing fields](https://github.com/ggml-org/llama.cpp/blob/b12498/tools/server/server-common.cpp#L139-L151)

The `warm-stop-and-follow-up` entry runs after the first Instant text reply, while the same model is loaded. It stops after answer text appears, checks that the partial reply and the drafted follow-up survive, and sends the follow-up in the same chat. The follow-up must recall the review code in the interrupted prompt and reuse the loaded OpenVINO GPU model.

- `stopToBackendEventMs` measures the click through receipt of the stopped SSE event. An unavailable event is `null`.
- `stopToSendReadyFrameMs` measures when the enabled Send control returns with the draft intact. `stopToSettledFrameMs` measures the frame with the settled partial reply.
- `followUp` records its first answer and engine counters from its own Send. These checkpoints measure backend stop reporting and prompt usability. GPU kernel completion and memory eviction need separate measurements.
