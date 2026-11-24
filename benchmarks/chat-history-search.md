# Chat history search benchmark

Fern searches the rendered text of 3,168 saved messages in 100 synthetic chats. The two search phrases span Markdown formatting and occur only in replies. Each session starts with the same saved draft, measures the first query with a fresh search index, then alternates between the two queries with the index warm. The run checks that Enter opens the correct chat and highlights the matching reply.

## Run on a built checkout

From the repository root, install dependencies and the Playwright Chromium browser. Build the checkout you intend to measure.

```sh
npm ci
npx playwright install chromium
npm run build
node benchmarks/chat-history-search.mjs renderer > chat-history-renderer.json
```

Run the same fixture in Electron with Fern’s normal local backend and an isolated profile. The source build uses the Python environment described in the [development setup](../README.md#development).

```sh
node benchmarks/chat-history-search.mjs electron > chat-history-electron.json
```

For a packaged test, set `FERN_E2E_EXECUTABLE` to the native executable and `FERN_BENCH_REVISION` to the SHA that produced it. Run the Electron command on the target operating system. Set `FERN_E2E_VISIBLE=1` for a visible native window and use the same visibility for both candidates. Keep the machine idle during measurement. The test uses synthetic history and needs no model downloads.

To measure typing rather than setting the full query in one input event, set `FERN_BENCH_SEARCH_INPUT=keys`. The driver sends individual key events with no added delay. Set `FERN_BENCH_SEARCH_OPENER=keyboard` to open the same search control with Enter. By default the benchmark clicks the opener and sets the full query in one event, matching the original baseline.

```sh
FERN_E2E_VISIBLE=1 FERN_BENCH_SEARCH_INPUT=keys node benchmarks/chat-history-search.mjs electron
```

## Read the report

- **First frame** is the time from the input event to the next animation frame. **Longest frame gap** tracks stalls until the search settles.
- **First result frame** is the first frame at which the expected row is available. **Complete frame** is the first such frame after message search finishes. A long total can coexist with a responsive search field.
- **Enter query** measures the time from the first input event until the full phrase is in the field. It includes the driver's timing between key events. Use **Complete after query** to compare the wait after the last character. Compare runs with the same opener, input method, and window visibility.
- The report includes every sample, median, nearest-rank p95, and maximum. The default five fresh sessions produce five cold and 100 warm samples. Use the cold median and maximum with that sample size. For a quick check, set `FERN_BENCH_RUNS=1` and `FERN_BENCH_WARM_RUNS=2`.
- Renderer runs serve the built assets and use fixture API responses. Electron runs use the real desktop window and backend but seed the same synthetic data. Compare results within the same mode, machine, viewport, and visibility. Use the same harness for both builds. Neither mode measures model inference, app launch, or physical display presentation.

## Baseline at 1f175a0

Measured November 23, 2026 on an Intel Core i5-8210Y Mac with 8 GiB RAM. There were five cold and 100 warm measurements per mode. The native app was a source build with a hidden window and a real backend.

| Mode | Cold first result median | Cold complete median / max | Longest cold frame gap median / max | Warm complete p95 |
| --- | ---: | ---: | ---: | ---: |
| Built renderer, Chromium 156 | 4.49 s | 4.49 s / 6.92 s | 40 ms / 162 ms | 50 ms |
| Built Electron 43.2 | 4.68 s | 4.68 s / 5.63 s | 150 ms / 201 ms | 48 ms |

The first result arrived when the full search completed in both modes. Profile the first history handoff as well as indexing before optimizing the cold path. Warm query times already meet the roadmap’s 100 ms p95 target on this fixture. [Product revision](https://github.com/xgirls-dev/fern/commit/1f175a00598c0294961c8092c69aeb06a07f7f8f)

## Individual key events

On November 23, 2026, the same Intel Mac ran a source-built Electron window with four fresh sessions and eight warm queries per opener and build. Every query used individual key events and the same 100-chat fixture. The baseline was `cb809ed`.

| Opener | Cold median after last key, before / after | Warm worst after last key, before / after | Cold worst frame gap, before / after |
| --- | ---: | ---: | ---: |
| Mouse click | 2.40 s / 64 ms | 185 ms / 51 ms | 48 ms / 58 ms |
| Enter | 2.38 s / 62 ms | 706 ms / 69 ms | 30 ms / 28 ms |

The renderer used to send every prefix through the worker. Keeping only the latest waiting query improved cold typing, but a running prefix could still delay warm searches. The worker now scans in slices so it can cancel that work and take the latest query. Search still verifies exact rendered Markdown matches.

The default single-event test on the hidden source-built Electron window also ran five cold and 100 warm queries on the candidate. Cold completion was **336 ms** at the median and warm completion was **60 ms** at p95. The worst cold frame gap was **164 ms**, so that path still exceeds the roadmap’s 100 ms frame budget.
