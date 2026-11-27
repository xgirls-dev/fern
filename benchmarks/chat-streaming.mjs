import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "../tests/ui-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "renderer";
const scenario = process.argv[3] ?? "streaming";
const sendMethod = process.env.FERN_BENCH_STREAM_SEND ?? "click";
const workload = process.env.FERN_BENCH_STREAM_WORKLOAD ?? "mixed";
assert(["renderer", "electron"].includes(mode), "Choose renderer or electron.");
assert(["streaming", "send-feedback"].includes(scenario), "Choose streaming or send-feedback.");
assert(["click", "enter"].includes(sendMethod), "Choose click or enter for FERN_BENCH_STREAM_SEND.");
assert(["mixed", "prose"].includes(workload), "Choose mixed or prose for FERN_BENCH_STREAM_WORKLOAD.");
const visible = mode === "electron" && process.env.FERN_E2E_VISIBLE === "1";
const trace = process.env.FERN_BENCH_STREAM_TRACE === "1";
const codeLines = Number(process.env.FERN_BENCH_STREAM_CODE_LINES ?? 1);
assert(Number.isInteger(codeLines) && codeLines > 0 && codeLines <= 350, "Choose 1–350 lines of code.");
const historyMessages = Number(process.env.FERN_BENCH_STREAM_HISTORY ?? (scenario === "send-feedback" ? 1000 : 0));
assert(Number.isInteger(historyMessages) && historyMessages >= 0 && historyMessages <= 12_000, "Choose 0–12,000 saved messages.");
const sendSamples = Number(process.env.FERN_BENCH_SEND_SAMPLES ?? 120);
assert(scenario !== "send-feedback" || (Number.isInteger(sendSamples) && sendSamples >= 4 && sendSamples <= 500 && sendSamples % 4 === 0),
  "Choose a multiple of four from 4–500 for FERN_BENCH_SEND_SAMPLES.");
const sampleCount = 100;
const appendIntervalMs = 50;
const phase = "Waiting for the first token…";
const markerPattern = "stream-part-[0-9]{3}";
const jobEvents = new EventEmitter();
let activeResponse;
const textStatus = {
  models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
  ggufAvailable: true, supportsJobEvents: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  residentModel: null,
};
const viewport = { width: 1440, height: 920 };

function openJobEvents(request, response) {
  const params = new URL(request.url, "http://127.0.0.1").searchParams;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.flushHeaders();
  activeResponse = response;
  jobEvents.emit("connected", { id: params.get("jobId"), response });
}

async function openElectron() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-stream-bench-"));
  const data = path.join(scratch, "data");
  const server = createServer(openJobEvents);
  const env = {
    ...process.env, FERN_ROOT: data, INTEL_IRIS_ROOT: data, FERN_E2E_HEADLESS: visible ? "0" : "1",
    FERN_TEXT_MODEL_REGISTRY: path.join(scratch, "text-models.json"),
    FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratch, "image-models.json"),
    HF_HOME: path.join(scratch, "huggingface"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const close = async () => {
    try {
      await app?.close();
    } finally {
      if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    app = await electron.launch({
      args: [path.join(root, "apps", "desktop", "out", "main", "index.js"),
        `--user-data-dir=${path.join(scratch, "profile")}`],
      env, cwd: root, timeout: 180_000,
    });
    const page = await app.firstWindow({ timeout: 90_000 });
    const window = await app.browserWindow(page);
    await window.evaluate((browserWindow, { width, height }) => {
      browserWindow.setContentSize(width, height);
      browserWindow.webContents.setBackgroundThrottling(false);
    }, viewport);
    await expect.poll(() => window.evaluate((browserWindow) => browserWindow.isVisible())).toBe(visible);
    const api = await page.evaluate(() => window.studio.getApiBaseUrl());
    await expect.poll(() => fetch(api + "/api/health").then((response) => response.ok, () => false)).toBe(true);
    const state = { textStatus, textRequests: [] };
    const headers = { "Access-Control-Allow-Origin": "*" };
    await page.route(api + "/api/text/status", (route) => route.fulfill({ json: state.textStatus, headers }));
    await page.route(api + "/api/text/generate", (route) => {
      const payload = route.request().postDataJSON();
      state.textRequests.push(payload);
      state.textStatus.job = { id: payload.requestId, threadId: payload.threadId, modelId: payload.modelId,
        status: "running", partialText: "", phase: "Loading model", startedAt: Date.now() / 1000, result: null, error: null };
      return route.fulfill({ status: 202, json: { job: state.textStatus }, headers });
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.reload();
    return { page, state, close, errors, eventsOrigin: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    await close();
    throw error;
  }
}

const { page, state, close, errors, eventsOrigin } = mode === "electron" ? await openElectron() : await fixture({
  builtRenderer: true, firstRun: true, platform: process.platform, viewport, textStatus, textJobEvents: openJobEvents,
});

function emit(response, frame) {
  response.write("data: " + JSON.stringify(frame) + "\n\n");
}

function summarize(samples) {
  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

function revision() {
  return process.env.FERN_BENCH_REVISION
    ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function measureSendFeedback(trigger, method) {
  return trigger.evaluateHandle((element, method) => ({
    result: new Promise((resolve) => {
      const eventType = method === "enter" ? "keydown" : "click";
      let frame;
      let observer;
      function finish(result) {
        clearTimeout(timeout);
        if (frame !== undefined) cancelAnimationFrame(frame);
        observer?.disconnect();
        element.removeEventListener(eventType, start, true);
        resolve(result);
      }
      function start(event) {
        if (method === "enter" && event.key !== "Enter") return;
        const sent = performance.now();
        const feed = element.closest(".text-workspace").querySelector(".text-conversation");
        const hasReply = () => feed.querySelector(".text-message--streaming");
        let domMs;
        observer = new MutationObserver(() => {
          if (domMs === undefined && hasReply()) domMs = performance.now() - sent;
        });
        observer.observe(feed, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        function sample() {
          if (hasReply()) {
            const frameMs = performance.now() - sent;
            finish({ domMs: domMs ?? frameMs, frameMs });
          } else frame = requestAnimationFrame(sample);
        }
        frame = requestAnimationFrame(sample);
      }
      const timeout = setTimeout(() => finish({ error: "Send did not display a reply in progress." }), 10_000);
      element.addEventListener(eventType, start, { capture: true, once: true });
    }),
  }), method);
}

async function replaySendFeedback(composer, send, browser) {
  const methods = ["click", "enter", "enter", "click"];
  if (eventsOrigin) await page.evaluate((origin) => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url, options) {
        const endpoint = new URL(url, location.href);
        super(endpoint.pathname === "/api/text/job/events"
          ? origin + endpoint.pathname + endpoint.search : url, options);
      }
    };
  }, eventsOrigin);

  const samples = [];
  const reply = page.getByRole("article", { name: "Model response", exact: true }).last();
  for (let index = 0; index < sendSamples; index += 1) {
    const method = methods[index % methods.length];
    const number = index + 1;
    await composer.fill(`Review worksheet ${number}.`);
    await expect(send).toBeEnabled();
    if (method === "click") await send.hover();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const timing = await measureSendFeedback(method === "click" ? send : composer, method);
    const connected = once(jobEvents, "connected", { signal: AbortSignal.timeout(10_000) });
    const [connections] = await Promise.all([connected, method === "click" ? send.click() : composer.press("Enter")]);
    const [{ id, response }] = connections;
    const job = state.textStatus.job;
    assert.equal(id, job.id, "The stream must belong to the submitted reply.");
    assert.equal(state.textRequests.length, number, "Send must start exactly one request.");
    emit(response, { job: { ...job, phase } });
    const measurement = await timing.evaluate(({ result }) => result);
    await timing.dispose();
    assert(!measurement.error, measurement.error);
    assert(Number.isFinite(measurement.frameMs) && measurement.domMs >= 0 && measurement.frameMs >= measurement.domMs);

    const answer = `Worksheet ${number} is ready.`;
    state.textStatus.job = {
      ...job, status: "complete", partialText: answer, finishedAt: Date.now() / 1000,
      result: { inputTokens: 20, outputTokens: 8, generationSeconds: 0.2, tokensPerSecond: 40 },
    };
    emit(response, { job: state.textStatus.job });
    response.end();
    await expect(reply).toContainText(answer);
    samples.push({ number, method, ...measurement });
  }
  assert.deepEqual(errors, []);
  const summarizeMethod = (method) => {
    const family = samples.filter((sample) => sample.method === method);
    return { samples: family.length, feedbackMs: summarize(family.map(({ frameMs }) => frameMs)),
      replyDomMs: summarize(family.map(({ domMs }) => domMs)) };
  };
  console.log(JSON.stringify({
    revision: revision(), mode, visible, scenario, browser,
    host: { os: os.version(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    fixture: "deterministic server-sent events", historyMessages, count: samples.length,
    feedbackMs: summarize(samples.map(({ frameMs }) => frameMs)),
    click: summarizeMethod("click"), enter: summarizeMethod("enter"), samples,
  }, null, 2));
}

async function run() {
  await page.route("**/api/text/job", (route) => route.fulfill({
    json: state.textStatus.job, headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  if (historyMessages) {
    const id = "text-thread-stream-benchmark";
    await composer.waitFor();
    await savedTextWorkspace(page, {
      activeId: id,
      threads: [{
        id, title: "Streaming benchmark", modelId: "local",
        messages: Array.from({ length: historyMessages }, (_, index) => ({
          id: `saved-${index}`, role: index % 2 ? "assistant" : "user",
          content: `Saved workshop note ${index + 1}. Review the schedule, room assignments, and handouts before the next meeting.`,
          createdAt: index + 1,
        })),
      }],
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Streaming benchmark", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(new RegExp(`^Saved workshop note ${historyMessages}\\.`))).toBeVisible({ timeout: 20_000 });
    await page.locator(".text-transcript-page").last().evaluate((pageElement) => {
      pageElement.dataset.benchmarkSavedTail = "true";
    });
  }
  const browser = await page.evaluate(() => ({ userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, devicePixelRatio }));
  if (scenario === "send-feedback") return replaySendFeedback(composer, send, browser);
  await composer.fill("Draft workshop notes and end with a short table and code example.");
  await (sendMethod === "enter" ? composer : send).evaluate((trigger, { sampleCount, markerPattern, sendMethod, eventsOrigin, trace, codeLines }) => {
    const marker = new RegExp(markerPattern, "g");
    const arrivals = new Map();
    const rendered = new Map();
    let requestStarted;
    let responseReceived;
    let streamCreated;
    let streamOpened;
    let firstBackend;
    let firstText;
    let terminal;
    const workerEvents = [];
    const longTasks = [];
    const longFrames = [];
    let timingObserver;
    function collectTimings(entries) {
      for (const entry of entries) {
        if (entry.entryType === "longtask") {
          longTasks.push({ at: entry.startTime, duration: entry.duration });
        } else {
          longFrames.push({ at: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration,
            renderAt: entry.renderStart, layoutAt: entry.styleAndLayoutStart,
            scripts: entry.scripts.map((script) => ({ invoker: script.invoker, functionName: script.sourceFunctionName,
              duration: script.duration, forcedLayout: script.forcedStyleAndLayoutDuration })) });
        }
      }
    }
    function stopTiming() {
      if (!timingObserver) return;
      collectTimings(timingObserver.takeRecords());
      timingObserver.disconnect();
    }
    if (trace) {
      const nativeFetch = window.fetch;
      window.fetch = function (input, options) {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.pathname !== "/api/text/generate") return nativeFetch.call(this, input, options);
        requestStarted ??= performance.now();
        const request = nativeFetch.call(this, input, options);
        void request.then(() => { responseReceived ??= performance.now(); }, () => {});
        return request;
      };
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          const worker = /(?:chatMarkdown|textCodeHighlight)\.worker/.exec(String(url))?.[0];
          if (!worker) return;
          const post = this.postMessage;
          this.postMessage = function (input, ...args) {
            const content = input.content ?? input.source;
            workerEvents.push({ at: performance.now(), event: "sent", worker, id: input.id, streaming: input.streaming,
              length: content.length, lastMarker: content.match(marker)?.at(-1), queue: options?.name,
              seedLength: input.seedPrefix?.source.length, seedBlocks: input.seedPrefix?.blockCount });
            post.call(this, input, ...args);
          };
          this.addEventListener("message", ({ data }) => workerEvents.push({ at: performance.now(), event: "received", worker, id: data.id,
            retainedBlocks: data.retained?.blockCount }));
        }
      };
      const entryTypes = ["longtask", "long-animation-frame"].filter((type) => PerformanceObserver.supportedEntryTypes.includes(type));
      if (entryTypes.length) {
        timingObserver = new PerformanceObserver((entries) => collectTimings(entries.getEntries()));
        timingObserver.observe({ entryTypes });
      }
    }
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        const endpoint = new URL(url, location.href);
        const isJobStream = endpoint.pathname === "/api/text/job/events";
        super(isJobStream && eventsOrigin ? eventsOrigin + endpoint.pathname + endpoint.search : url, options);
        if (!isJobStream) return;
        if (trace) {
          streamCreated ??= performance.now();
          this.addEventListener("open", () => { streamOpened ??= performance.now(); }, { once: true });
        }
        this.addEventListener("message", ({ data }) => {
          const received = performance.now();
          const event = JSON.parse(data);
          firstBackend ??= received;
          for (const name of event.append?.text.match(marker) ?? []) {
            arrivals.set(name, received);
            firstText ??= received;
          }
          if (event.job?.status === "complete") terminal = received;
        });
      }
    };

    window.fernStreamingMeasurement = new Promise((resolve) => {
      const conversation = document.querySelector(".text-conversation");
      const currentReply = () => conversation.querySelector(".text-transcript-page:last-child > .text-message--assistant:last-child");
      let traceMutations;
      let terminalCommitted;
      const committed = new Map();
      function recordCommit() {
        const row = currentReply();
        const body = row?.querySelector(".text-message-content");
        const now = performance.now();
        if (terminal !== undefined && terminalCommitted === undefined && row && !row.classList.contains("text-message--streaming") &&
            body?.querySelector("table") && body.querySelector("pre code")) terminalCommitted = now;
        for (const name of body?.textContent.match(marker) ?? []) {
          if (arrivals.has(name) && !committed.has(name)) committed.set(name, now);
        }
      }
      let frame;
      let observer;
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame);
        observer?.disconnect();
        traceMutations?.disconnect();
        stopTiming();
        resolve({ error: "The measured reply did not reach its final formatted frame." });
      }, 30_000);
      trigger.addEventListener(sendMethod === "enter" ? "keydown" : "click", () => {
        const sent = performance.now();
        let previous = sent;
        let firstFrame;
        let replyCommit;
        let firstFeedback;
        let firstVisible;
        let formattedAt;
        let firstSyntaxAt;
        let maxFrameGapMs = 0;
        let syntaxMaxFrameGapMs = 0;
        observer = new MutationObserver(() => {
          if (!conversation.querySelector(".text-message--streaming")) return;
          replyCommit = performance.now();
          observer.disconnect();
        });
        observer.observe(conversation, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        if (trace) {
          traceMutations = new MutationObserver(recordCommit);
          traceMutations.observe(conversation, { childList: true, subtree: true, characterData: true, attributeFilter: ["class"] });
        }
        const tick = () => {
          const now = performance.now();
          firstFrame ??= now;
          if (formattedAt === undefined) maxFrameGapMs = Math.max(maxFrameGapMs, now - previous);
          else syntaxMaxFrameGapMs = Math.max(syntaxMaxFrameGapMs, now - previous);
          previous = now;
          const row = currentReply();
          const body = row?.querySelector(".text-message-content");
          const stream = row?.classList.contains("text-message--streaming");
          if (stream) firstFeedback ??= now;
          for (const name of (formattedAt === undefined ? body?.textContent.match(marker) : null) ?? []) {
            const received = arrivals.get(name);
            if (received === undefined || rendered.has(name)) continue;
            rendered.set(name, { marker: name, receiptToFrameMs: now - received });
            firstVisible ??= now;
          }
          if (formattedAt === undefined && terminal !== undefined && row && !stream && body?.querySelector("table") &&
              body.querySelector("pre code") && rendered.size === sampleCount) formattedAt = now;
          const coloredLines = codeLines > 1 ? CSS.highlights.get("fern-code-keyword")?.size ?? 0 : 0;
          if (formattedAt !== undefined && coloredLines > 0) firstSyntaxAt ??= now;
          const colored = coloredLines >= codeLines;
          if (formattedAt !== undefined && (codeLines === 1 || colored)) {
            clearTimeout(timeout);
            observer.disconnect();
            traceMutations?.disconnect();
            stopTiming();
            resolve({
              sendToFirstFrameMs: firstFrame - sent,
              sendToReplyCommitMs: replyCommit - sent,
              sendToFeedbackMs: firstFeedback - sent,
              sendToFirstEventMs: firstBackend - sent,
              sendToFirstVisibleTextMs: firstVisible - sent,
              firstTextReceiptToFrameMs: firstVisible - firstText,
              terminalReceiptToFormattedFrameMs: formattedAt - terminal,
              ...(colored ? { formattedToFirstSyntaxFrameMs: firstSyntaxAt - formattedAt,
                formattedToFullSyntaxFrameMs: now - formattedAt, syntaxMaxFrameGapMs } : {}),
              maxFrameGapMs,
              samples: [...rendered.values()],
              ...(trace ? { trace: { sentAt: sent, terminalAt: terminal, terminalCommittedAt: terminalCommitted ?? null,
                settledAt: formattedAt, observedAt: now, workerEvents, longTasks, longFrames,
                startup: Object.fromEntries(Object.entries({ requestStarted, responseReceived, streamCreated, streamOpened,
                  firstBackend }).map(([name, at]) => [name, at === undefined ? null : at - sent])),
                updates: [...rendered.values()].map((sample) => {
                  const received = arrivals.get(sample.marker);
                  return { marker: sample.marker, receivedAt: received, committedAt: committed.get(sample.marker) ?? null,
                    frameAt: received + sample.receiptToFrameMs };
                }) } } : {}),
            });
            return;
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, { once: true, capture: true });
    });
  }, { sampleCount, markerPattern, sendMethod, eventsOrigin, trace, codeLines });

  const readyStream = once(jobEvents, "connected", { signal: AbortSignal.timeout(10_000) }).then(([{ id, response }]) => {
    assert.equal(state.textRequests.length, 1, "Send must start exactly one request.");
    const job = state.textStatus.job;
    assert.equal(id, job.id, "The stream must be for the submitted reply.");
    emit(response, { job: { ...job, phase } });
    return { job, response };
  });
  const [{ job, response }] = await Promise.all([
    readyStream,
    sendMethod === "enter" ? composer.press("Enter") : send.click(),
  ]);

  let partialText = "";
  for (let number = 1; number <= sampleCount; number += 1) {
    await delay(appendIntervalMs);
    const marker = "stream-part-" + String(number).padStart(3, "0");
    const line = workload === "prose" ? "Notes are ready. " + marker
      : number % 10 === 0 ? "**" + marker + "** notes are ready. 🎙️" : marker + " notes are ready.";
    const text = (number === 1 ? "" : number % 10 === 0 ? "\n\n" : " ") + line;
    partialText += text;
    emit(response, { append: { phase, text, reasoning: "" } });
  }
  const fence = String.fromCharCode(96).repeat(3);
  const code = codeLines === 1 ? "const ready = true;" : Array.from({ length: codeLines }, (_, index) =>
    `const line${index} = "A finished code snippet should remain easy to read."; // workshop`).join("\n");
  const formatting = "\n\n| Item | Status |\n| --- | --- |\n| Notes | Ready |\n\n" + fence +
    "js\n" + code + "\n" + fence;
  await delay(appendIntervalMs);
  emit(response, { append: { phase, text: formatting, reasoning: "" } });
  await delay(appendIntervalMs);
  const residentModel = { modelId: job.modelId, backend: "openvino", device: "CPU",
    gguf: { contextSize: 8192, loadOptions: {} } };
  state.textStatus.job = {
    ...job, status: "complete", partialText: partialText + formatting, finishedAt: Date.now() / 1000,
    result: { inputTokens: 18, outputTokens: 500, generationSeconds: 5, tokensPerSecond: 100 },
    residentModel,
  };
  state.textStatus.residentModel = residentModel;
  emit(response, { job: state.textStatus.job });
  response.end();

  const measurement = await page.evaluate(() => window.fernStreamingMeasurement);
  assert(!measurement.error, measurement.error);
  if (historyMessages) await expect(page.locator("[data-benchmark-saved-tail]")).toHaveCount(1);
  const { samples, trace: frameTrace, ...milestones } = measurement;
  assert.equal(samples.length, sampleCount);
  for (const [key, value] of Object.entries(milestones)) assert(Number.isFinite(value) && value >= 0, key);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    revision: revision(), mode, visible, sendMethod, browser, fixture: "deterministic server-sent events",
    host: { os: os.version(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    sampleCount, appendIntervalMs, codeLines, workload, historyMessages, milestones,
    receiptToFrameMs: summarize(samples.map(({ receiptToFrameMs }) => receiptToFrameMs)), samples,
    ...(frameTrace ? { trace: frameTrace } : {}),
  }, null, 2));
}

try {
  await run();
} finally {
  if (activeResponse && !activeResponse.writableEnded) activeResponse.end();
  await close();
}
