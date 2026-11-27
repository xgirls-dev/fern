import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { measureWarmStop, observeChatReply, readReplyTiming, verifyPromptDetails } from "../apps/desktop/e2e/chat-reply-timing.mjs";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

let stream;
let connections = 0;
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobEvents: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
  textJobEvents: (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    stream = response;
    connections++;
  },
});
const emit = (frame) => stream.write("data: " + JSON.stringify(frame) + "\n\n");
const firstAdmission = Promise.withResolvers();

try {
  const idleJob = state.textStatus.job;
  await page.route("**/api/text/job", (route) => route.fulfill({ json: connections ? state.textStatus.job : idleJob }));
  await page.route("**/api/text/generate", async (route) => {
    const request = route.request().postDataJSON();
    const { requestId, threadId, modelId } = request;
    state.textRequests.push(request);
    await firstAdmission.promise;
    const textJob = { id: requestId, threadId, modelId, status: "running", partialText: "", phase: "Loading model…",
      startedAt: Date.now() / 1000, result: null, error: null };
    state.textStatus.job = textJob;
    await route.fulfill({ status: 202, json: { textJob } });
  }, { times: 1 });
  await page.evaluate(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        window.firstStreamPhase ??= document.querySelector(".text-message--streaming .text-reply-stage")?.textContent;
      }
    };
    window.originalBenchEventSource = window.EventSource;
    window.originalBenchFetch = window.fetch;
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Measure a short synthetic reply.");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const timing = await observeChatReply(send);
  await send.click();
  const reply = page.locator(".text-message--assistant").last();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await expect(reply).toContainText("Starting response…");
  firstAdmission.resolve();
  await expect.poll(() => Boolean(stream)).toBe(true);
  assert.equal(await page.evaluate(() => window.firstStreamPhase), "Starting response…",
    "A confirmed job should connect before the renderer commits the loading status.");
  const running = state.textStatus.job;
  emit({ job: { ...running, phase: "Loading model…" } });
  await expect(reply.getByText("Loading model…", { exact: true })).toBeVisible();
  emit({ append: { phase: "Generating…", reasoning: "", text: "The measured answer." } });
  await expect(reply.locator(".text-message-content p")).toHaveText("The measured answer.");
  // The DOM assertion can resolve before the timing probe samples a frame.
  await reply.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  state.textStatus.job = { ...running, partialText: "The measured answer.", status: "complete", finishedAt: Date.now() / 1000 };
  emit({ job: state.textStatus.job });
  stream.end();

  const measured = await readReplyTiming(timing);
  for (const name of ["feedbackFrameMs", "generateRequestMs", "generateResponseMs", "streamStartMs", "streamOpenMs",
    "firstBackendEventMs", "firstAnswerEventMs",
    "firstAnswerFrameMs", "terminalEventMs", "settledFrameMs", "maxFrameGapMs"]) {
    assert(Number.isFinite(measured[name]) && measured[name] >= 0, name);
  }
  assert(measured.generateRequestMs <= measured.generateResponseMs);
  assert(measured.generateRequestMs <= measured.streamStartMs);
  assert(measured.streamStartMs <= measured.streamOpenMs);
  assert(measured.streamOpenMs <= measured.firstBackendEventMs);
  assert(await page.evaluate(() => window.fetch === window.originalBenchFetch));
  assert(measured.feedbackFrameMs < measured.firstAnswerEventMs);
  assert(measured.firstBackendEventMs < measured.firstAnswerEventMs);
  assert(measured.firstAnswerEventMs <= measured.firstAnswerFrameMs);
  assert(measured.firstAnswerFrameMs <= measured.terminalEventMs);
  assert(measured.terminalEventMs <= measured.settledFrameMs);
  // The backend acknowledges Stop before reporting that the job has ended.
  const stoppedIds = [];
  const partialMarkdown = "1. **Woodworking";
  await page.route("**/api/text/stop", async (route) => {
    stoppedIds.push(route.request().postDataJSON().requestId);
    await route.fulfill({ status: 202, json: { textJob: state.textStatus.job } });
    state.textStatus.job = { ...state.textStatus.job, status: "stopped", finishedAt: Date.now() / 1000 };
    emit({ job: state.textStatus.job });
    stream.end();
  });

  async function driveWarmStop() {
    await expect.poll(() => connections).toBe(2);
    state.textStatus.job = { ...state.textStatus.job, partialText: partialMarkdown, phase: "Waiting for the first token…" };
    emit({ job: state.textStatus.job });
    await expect.poll(() => connections).toBe(3);
    state.textStatus.job = {
      ...state.textStatus.job, partialText: "ORCHID-42", status: "complete", finishedAt: Date.now() / 1000,
      result: { inputTokens: 37, outputTokens: 6, generationSeconds: 0.4, tokensPerSecond: 15, backend: "OpenVINO", device: "GPU",
        runtimeTiming: { prefillMs: 20, decodeMs: 80, evaluatedPromptTokens: 5, cachedPromptTokens: 32 } },
    };
    emit({ job: state.textStatus.job });
    stream.end();
  }

  const [warm] = await Promise.all([measureWarmStop(page, () => state.textStatus.job, "local"), driveWarmStop()]);
  assert.equal(connections, 3, "The committed status must reuse each accepted stream.");
  assert.deepEqual(stoppedIds, [state.textRequests[1].requestId]);
  assert(state.textRequests[2].messages.some(({ role, content }) => role === "user" && content.includes("ORCHID-42")));
  assert.equal(state.textRequests[2].threadId, state.textRequests[1].threadId);
  assert(warm.stoppedReply.stopKeyMs >= warm.stoppedReply.firstAnswerFrameMs);
  assert(Number.isFinite(warm.stopToBackendEventMs) && warm.stopToBackendEventMs >= 0);
  assert(Number.isFinite(warm.stopToSendReadyFrameMs) && warm.stopToSendReadyFrameMs >= 0);
  assert(Number.isFinite(warm.stopToSettledFrameMs) && warm.stopToSettledFrameMs >= 0);
  assert.equal(warm.followUp.runtime.cachedPromptTokens, 32);
  assert.equal(warm.followUp.backend, "OpenVINO");
  assert(await page.evaluate(() => window.EventSource === window.originalBenchEventSource));
  const stoppedReply = page.getByRole("article", { name: "Model response", exact: true })
    .filter({ hasText: "Stopped · Partial response" });
  await expect(stoppedReply.locator("li strong")).toHaveText("Woodworking", { timeout: 3_000 });
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads.find(({ id }) => id === state.textRequests[1].threadId)
    ?.messages.find(({ jobId }) => jobId === stoppedIds[0])?.content).toBe(partialMarkdown);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads.find(({ id }) => id === state.textRequests[2].threadId)?.messages.at(-1)?.jobId)
    .toBe(state.textRequests[2].requestId);
  await page.reload();
  await expect(stoppedReply.locator("li strong")).toHaveText("Woodworking", { timeout: 15_000 });
  await expect(reply.locator(".text-message-content")).toContainText("ORCHID-42");
  assert.equal(await verifyPromptDetails(reply, warm.followUp.runtime), "Prompt processing 20 ms · 5 tokens processed · 32 tokens reused");
  assert.deepEqual(errors, []);
  console.log("The benchmark distinguishes loading, first answer, backend Stop, composer readiness, and the warm follow-up.");
} finally {
  firstAdmission.resolve();
  stream?.end();
  await close();
}
