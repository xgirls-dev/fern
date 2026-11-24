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

Repeat under the same machine load, browser, and viewport conditions. The script verifies that all 100 updates appeared and that the completed Markdown table and code block rendered. Keep the revision and raw JSON when comparing runs.

## Read the report

- **Send to feedback** measures the click to the first frame with the reply in progress. **Send to first event** measures the click to receipt of the first status snapshot. The fixture controls when that snapshot arrives.
- **First text receipt to frame** measures when the first incremental text arrives in the renderer and when it is first present in a render opportunity. The per-update samples use the same boundary for each of the 100 unique markers.
- **Terminal receipt to formatted frame** measures the completed event to the first frame with the settled reply, table, and code block.
- **Longest frame gap** measures all sampled animation frames from Send through final formatting. It includes the first frame after clicking.

This fixture exercises Chromium, the production renderer, and the streaming client. Timings characterize this renderer replay, with the browser frame as a proxy for presentation. Real model load, inference, native window handling, and display scanout need separate measurements on the package.

## Renderer baseline at 495af8e

Three fresh headless Chromium runs on November 23, 2026 used an Intel Core i5-8210Y Mac with 8 GiB RAM. All 300 updates appeared and all three final replies rendered their table and code block.

| Measurement | Result |
| --- | ---: |
| Incremental receipt to frame, pooled p95 / max | 56 ms / 412 ms |
| First text receipt to frame, range | 15–33 ms |
| Send click to reply-in-progress frame, range | 154–344 ms |
| Terminal receipt to formatted reply, range | 59–258 ms |

The incremental p95 is below the roadmap's 100 ms streaming target on this fixture. The Send row and the tail of final formatting need investigation in a visible native window.
