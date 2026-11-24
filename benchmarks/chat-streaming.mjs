import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { fixture } from "../tests/ui-fixture.mjs";

const sampleCount = 100;
const appendIntervalMs = 50;
const phase = "Waiting for the first token…";
const markerPattern = "stream-part-[0-9]{3}";
let connection;
const { page, state, close, errors } = await fixture({
  builtRenderer: true,
  firstRun: true,
  platform: process.platform,
  viewport: { width: 1440, height: 920 },
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobEvents: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
  textJobEvents: (request, response) => {
    const params = new URL(request.url, "http://fixture").searchParams;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    connection = { id: params.get("jobId"), response };
  },
});

function emit(frame) {
  connection.response.write("data: " + JSON.stringify(frame) + "\n\n");
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

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await composer.fill("Draft workshop notes and end with a short table and code example.");
  await send.evaluate((button, { sampleCount, markerPattern }) => {
    const marker = new RegExp(markerPattern, "g");
    const arrivals = new Map();
    const rendered = new Map();
    let firstBackend;
    let firstText;
    let terminal;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        if (new URL(url, location.href).pathname !== "/api/text/job/events") return;
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
      let frame;
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame);
        resolve({ error: "The measured reply did not reach its final formatted frame." });
      }, 30_000);
      button.addEventListener("click", () => {
        const sent = performance.now();
        let previous = sent;
        let firstFeedback;
        let firstVisible;
        let maxFrameGapMs = 0;
        const tick = () => {
          const now = performance.now();
          maxFrameGapMs = Math.max(maxFrameGapMs, now - previous);
          previous = now;
          const row = document.querySelector(".text-message--assistant");
          const body = row?.querySelector(".text-message-content");
          const stream = row?.classList.contains("text-message--streaming");
          if (stream) firstFeedback ??= now;
          for (const name of body?.textContent.match(marker) ?? []) {
            const received = arrivals.get(name);
            if (received === undefined || rendered.has(name)) continue;
            rendered.set(name, { marker: name, receiptToFrameMs: now - received });
            firstVisible ??= now;
          }
          if (terminal !== undefined && row && !stream && body?.querySelector("table") && body.querySelector("pre code") &&
              rendered.size === sampleCount) {
            clearTimeout(timeout);
            resolve({
              sendToFeedbackMs: firstFeedback - sent,
              sendToFirstEventMs: firstBackend - sent,
              sendToFirstVisibleTextMs: firstVisible - sent,
              firstTextReceiptToFrameMs: firstVisible - firstText,
              terminalReceiptToFormattedFrameMs: now - terminal,
              maxFrameGapMs,
              samples: [...rendered.values()],
            });
            return;
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, { once: true, capture: true });
    });
  }, { sampleCount, markerPattern });

  await send.click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  const job = state.textStatus.job;
  await expect.poll(() => connection?.id).toBe(job.id);
  emit({ job: { ...job, phase } });

  let partialText = "";
  for (let number = 1; number <= sampleCount; number += 1) {
    await delay(appendIntervalMs);
    const marker = "stream-part-" + String(number).padStart(3, "0");
    const line = number % 10 === 0 ? "**" + marker + "** notes are ready. 🎙️" : marker + " notes are ready.";
    const text = (number === 1 ? "" : number % 10 === 0 ? "\n\n" : " ") + line;
    partialText += text;
    emit({ append: { phase, text, reasoning: "" } });
  }
  const fence = String.fromCharCode(96).repeat(3);
  const formatting = "\n\n| Item | Status |\n| --- | --- |\n| Notes | Ready |\n\n" + fence +
    "js\nconst ready = true;\n" + fence;
  await delay(appendIntervalMs);
  emit({ append: { phase, text: formatting, reasoning: "" } });
  await delay(appendIntervalMs);
  state.textStatus.job = {
    ...job, status: "complete", partialText: partialText + formatting, finishedAt: Date.now() / 1000,
    result: { inputTokens: 18, outputTokens: 500, generationSeconds: 5, tokensPerSecond: 100 },
  };
  emit({ job: state.textStatus.job });
  connection.response.end();

  const measurement = await page.evaluate(() => window.fernStreamingMeasurement);
  assert(!measurement.error, measurement.error);
  const { samples, ...milestones } = measurement;
  assert.equal(samples.length, sampleCount);
  for (const [key, value] of Object.entries(milestones)) assert(Number.isFinite(value) && value >= 0, key);
  assert.deepEqual(errors, []);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
  }).trim();
  console.log(JSON.stringify({
    revision, userAgent, fixture: "built renderer with deterministic server-sent events",
    host: { os: os.version(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    sampleCount, appendIntervalMs, milestones,
    receiptToFrameMs: summarize(samples.map(({ receiptToFrameMs }) => receiptToFrameMs)), samples,
  }, null, 2));
} finally {
  connection?.response.end();
  await close();
}
