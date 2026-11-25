import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { measureWarmStop, observeChatReply, readReplyTiming } from "../apps/desktop/e2e/chat-reply-timing.mjs";
import { fixture } from "./ui-fixture.mjs";

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

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.evaluate(() => { window.originalBenchEventSource = window.EventSource; });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Measure a short synthetic reply.");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const timing = await observeChatReply(send);
  await send.click();
  const reply = page.locator(".text-message--assistant").last();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await expect.poll(() => Boolean(stream)).toBe(true);
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
  for (const name of ["feedbackFrameMs", "firstBackendEventMs", "firstAnswerEventMs",
    "firstAnswerFrameMs", "terminalEventMs", "settledFrameMs", "maxFrameGapMs"]) {
    assert(Number.isFinite(measured[name]) && measured[name] >= 0, name);
  }
  assert(measured.feedbackFrameMs < measured.firstAnswerEventMs);
  assert(measured.firstBackendEventMs < measured.firstAnswerEventMs);
  assert(measured.firstAnswerEventMs <= measured.firstAnswerFrameMs);
  assert(measured.firstAnswerFrameMs <= measured.terminalEventMs);
  assert(measured.terminalEventMs <= measured.settledFrameMs);
  // The backend acknowledges Stop before reporting that the job has ended.
  const stoppedIds = [];
  await page.route("**/api/text/stop", async (route) => {
    stoppedIds.push(route.request().postDataJSON().requestId);
    await route.fulfill({ status: 202, json: { textJob: state.textStatus.job } });
    state.textStatus.job = { ...state.textStatus.job, status: "stopped", finishedAt: Date.now() / 1000 };
    emit({ job: state.textStatus.job });
    stream.end();
  });

  async function driveWarmStop() {
    await expect.poll(() => connections).toBe(2);
    state.textStatus.job = { ...state.textStatus.job, partialText: "1. A notebook", phase: "Waiting for the first token…" };
    emit({ job: state.textStatus.job });
    await expect.poll(() => connections).toBe(3);
    state.textStatus.job = {
      ...state.textStatus.job, partialText: "ORCHID-42", status: "complete", finishedAt: Date.now() / 1000,
      result: { inputTokens: 37, outputTokens: 6, generationSeconds: 0.4, tokensPerSecond: 15, backend: "OpenVINO", device: "GPU",
        runtimeTiming: { prefillMs: 20, decodeMs: 80, cachedPromptTokens: 32 } },
    };
    emit({ job: state.textStatus.job });
    stream.end();
  }

  const [warm] = await Promise.all([measureWarmStop(page, () => state.textStatus.job, "local"), driveWarmStop()]);
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
  assert.deepEqual(errors, []);
  console.log("The benchmark distinguishes loading, first answer, backend Stop, composer readiness, and the warm follow-up.");
} finally {
  stream?.end();
  await close();
}
