import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { observeChatReply } from "../apps/desktop/e2e/chat-reply-timing.mjs";
import { fixture } from "./ui-fixture.mjs";

let stream;
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
  state.textStatus.job = { ...running, partialText: "The measured answer.", status: "complete", finishedAt: Date.now() / 1000 };
  emit({ job: state.textStatus.job });
  stream.end();

  const measured = await timing.evaluate(({ result }) => result);
  await timing.dispose();
  for (const name of ["feedbackFrameMs", "firstBackendEventMs", "firstAnswerEventMs",
    "firstAnswerFrameMs", "terminalEventMs", "settledFrameMs", "maxFrameGapMs"]) {
    assert(Number.isFinite(measured[name]) && measured[name] >= 0, name);
  }
  assert(measured.feedbackFrameMs < measured.firstAnswerEventMs);
  assert(measured.firstBackendEventMs < measured.firstAnswerEventMs);
  assert(measured.firstAnswerEventMs <= measured.firstAnswerFrameMs);
  assert(measured.firstAnswerFrameMs <= measured.terminalEventMs);
  assert(measured.terminalEventMs <= measured.settledFrameMs);
  assert(await page.evaluate(() => window.EventSource === window.originalBenchEventSource));
  assert.deepEqual(errors, []);
  console.log("The benchmark distinguishes loading, SSE receipt, first rendered answer text, and the settled reply.");
} finally {
  stream?.end();
  await close();
}
