import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Observe the actual renderer stream and frame callbacks without replacing replies.
export function observeChatReply(send, { measureStop = false } = {}) {
  return send.evaluateHandle((button, measureStop) => {
    const result = new Promise((resolve) => {
      const feed = document.querySelector(".text-conversation");
      const composer = button.closest("form.text-composer");
      if (!feed || !composer) throw new Error("Open a chat before measuring a reply.");
      const assistant = ".text-message--assistant";
      const priorRows = new Set([...feed.querySelectorAll(assistant)].map((row) => row.getAttribute("data-chat-message")));
      button.addEventListener("click", () => {
        const sent = performance.now();
        const NativeEventSource = window.EventSource;
        const nativeFetch = window.fetch;
        let firstEvent = null;
        let firstAnswerEvent = null;
        let terminalEvent = null;
        let feedback = null;
        let firstAnswerFrame = null;
        let stopKey = null;
        let stopRequest = null;
        let stopFeedback = null;
        let sendReady = null;
        let settled = null;
        let lastFrame = sent;
        let maxFrameGap = 0;
        let animation;
        const watchdog = setTimeout(() => finish({ error: "The reply did not reach a settled frame." }), 360_000);

        function finish(value) {
          clearTimeout(watchdog);
          cancelAnimationFrame(animation);
          feed.removeEventListener("keydown", recordStop, true);
          if (window.EventSource === TimedEventSource) window.EventSource = NativeEventSource;
          if (window.fetch === timedFetch) window.fetch = nativeFetch;
          resolve(value);
        }

        function recordStop(event) {
          if (event.key === "Escape" && event.target instanceof Element && event.target.matches(".text-message--streaming")) {
            stopKey ??= performance.now();
          }
        }
        function timedFetch(input, options) {
          const url = new URL(input instanceof Request ? input.url : input, location.href);
          if (stopKey !== null && url.pathname === "/api/text/stop") stopRequest ??= performance.now();
          return nativeFetch.call(this, input, options);
        }
        if (measureStop) {
          feed.addEventListener("keydown", recordStop, true);
          window.fetch = timedFetch;
        }

        class TimedEventSource extends NativeEventSource {
          constructor(url, options) {
            super(url, options);
            if (new URL(url, location.href).pathname !== "/api/text/job/events") return;
            this.addEventListener("message", ({ data }) => {
              let event;
              try { event = JSON.parse(data); } catch { return; }
              if (!event?.job && !event?.append) return;
              const now = performance.now();
              firstEvent ??= now;
              if ((event.append?.text ?? event.job?.partialText)?.trim()) firstAnswerEvent ??= now;
              if (["complete", "stopped", "failed"].includes(event.job?.status)) terminalEvent ??= now;
            });
          }
        }
        window.EventSource = TimedEventSource;

        function frame() {
          const now = performance.now();
          maxFrameGap = Math.max(maxFrameGap, now - lastFrame);
          lastFrame = now;
          const rows = feed.querySelectorAll(assistant);
          const reply = rows[rows.length - 1];
          if (reply && !priorRows.has(reply.getAttribute("data-chat-message"))) {
            feedback ??= now;
            const content = reply.querySelector(".text-message-content");
            if (firstAnswerFrame === null && content && [...content.childNodes].some((node) =>
              (node.nodeType === Node.TEXT_NODE || (node instanceof Element
                && !node.matches(".text-thinking, [data-chat-markdown-formatting]")))
              && node.textContent?.trim())) firstAnswerFrame = now;
            if (!reply.classList.contains("text-message--streaming") &&
                !content?.querySelector("[data-chat-markdown-formatting]")) settled ??= now;
          }
          if (stopKey !== null) {
            if (composer.querySelector('button[aria-label="Send message"]:enabled:not([aria-disabled="true"])')) sendReady ??= now;
            const stopPending = composer.querySelector('button[aria-label="Stop generation"]:is(:disabled,[aria-disabled="true"])');
            if (stopPending || sendReady !== null) stopFeedback ??= now;
          }
          if (settled !== null && (!measureStop || sendReady !== null)) {
            const afterSend = (at) => at === null ? null : at - sent;
            finish({
              feedbackFrameMs: afterSend(feedback),
              firstBackendEventMs: afterSend(firstEvent),
              firstAnswerEventMs: afterSend(firstAnswerEvent),
              firstAnswerFrameMs: afterSend(firstAnswerFrame),
              terminalEventMs: afterSend(terminalEvent),
              settledFrameMs: afterSend(settled),
              maxFrameGapMs: maxFrameGap,
              ...(measureStop ? { stopKeyMs: afterSend(stopKey), stopRequestMs: afterSend(stopRequest),
                stopFeedbackFrameMs: afterSend(stopFeedback), sendReadyFrameMs: afterSend(sendReady) } : {}),
            });
            return;
          }
          animation = requestAnimationFrame(frame);
        }
        animation = requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
    return { result };
  }, measureStop);
}

const timeout = 360_000;
const stopPrompt = "The review code is ORCHID-42. Write a numbered list of 400 different workshop supplies. Start the list now.";
const followUpPrompt = "What review code did I give you? Reply with the code only.";

export async function readReplyTiming(handle) {
  try {
    const measured = await handle.evaluate(({ result }) => result);
    assert(!measured.error, measured.error);
    assert(Number.isFinite(measured.firstAnswerFrameMs), "The renderer should show answer text in a frame.");
    return measured;
  } finally {
    await handle.dispose();
  }
}

export async function verifyPromptDetails(reply, timing) {
  assert(Number.isFinite(timing?.prefillMs) && timing.prefillMs >= 0, "The GGUF runtime should report prompt processing time.");
  assert(Number.isSafeInteger(timing.evaluatedPromptTokens) && timing.evaluatedPromptTokens >= 0, "The GGUF runtime should report processed tokens.");
  assert(Number.isSafeInteger(timing.cachedPromptTokens) && timing.cachedPromptTokens >= 0, "The GGUF runtime should report reused tokens.");
  const expected = await reply.evaluate((_, { prefillMs, evaluatedPromptTokens, cachedPromptTokens }) => {
    const elapsed = prefillMs < 1000 ? `${Math.round(prefillMs)} ms` : `${(prefillMs / 1000).toFixed(1)} s`;
    const tokens = (count) => `${count.toLocaleString()} ${count === 1 ? "token" : "tokens"}`;
    return `Prompt processing ${elapsed} · ${tokens(evaluatedPromptTokens)} processed · ${tokens(cachedPromptTokens)} reused`;
  }, timing);
  await reply.getByRole("button", { name: "More message actions", exact: true }).click();
  await reply.page().getByRole("menuitem", { name: "Response details", exact: true }).click();
  await expect(reply.getByRole("region", { name: "Response details" })).toContainText(expected);
  return expected;
}

export async function measureWarmStop(page, readJob, modelId) {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const reply = page.locator(".text-message--assistant").last();
  const responseText = (row) => row.locator(".text-message-content");

  await composer.fill(stopPrompt);
  const stoppedTiming = await observeChatReply(send, { measureStop: true });
  await send.click();
  const streaming = page.getByRole("article", { name: "Response in progress", exact: true });
  await expect(responseText(streaming).locator("p, li, pre, td").first()).toBeVisible({ timeout });
  const running = await readJob();
  assert.equal(running.status, "running", "The model completed before the Stop measurement.");
  assert.equal(running.modelId, modelId);

  await composer.fill(followUpPrompt);
  await composer.press("Shift+Tab");
  const goToReply = page.getByRole("button", { name: "Go to latest reply", exact: true });
  await expect(goToReply).toBeFocused();
  await goToReply.press("Enter");
  await expect(streaming).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(reply.getByText("Stopped · Partial response", { exact: true })).toBeVisible({ timeout });
  await expect(reply).toBeFocused();
  await expect(send).toBeEnabled({ timeout });
  await expect(composer).toHaveValue(followUpPrompt);
  const stopped = await readJob();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.id, running.id);
  assert(stopped.partialText?.trim(), "The stopped job should retain a partial answer.");
  const stopRenderer = await readReplyTiming(stoppedTiming);
  assert(Number.isFinite(stopRenderer.stopRequestMs), "Stop should issue a request to the text runtime.");

  const followUpTiming = await observeChatReply(send);
  const request = page.waitForRequest((entry) => entry.method() === "POST" &&
    new URL(entry.url()).pathname === "/api/text/generate");
  await send.click();
  const { requestId } = (await request).postDataJSON();
  const followUpReply = page.locator(`[data-chat-message=${JSON.stringify("response-" + requestId)}]`);
  await expect(followUpReply.getByRole("button", { name: "More message actions", exact: true })).toBeVisible({ timeout });
  await expect(responseText(followUpReply)).toContainText(/\bORCHID-42\b/i, { timeout });
  const followUp = await readJob();
  assert.equal(followUp.status, "complete");
  assert.equal(followUp.id, requestId);
  assert.equal(followUp.threadId, stopped.threadId);
  assert.equal(followUp.modelId, modelId);
  const runtime = followUp.result?.runtimeTiming;
  assert(runtime, "Use a build that reports GGUF runtime timings.");
  assert(!Object.hasOwn(runtime, "modelReadyMs"), "The follow-up should reuse the model loaded before Stop.");
  const followUpRenderer = await readReplyTiming(followUpTiming);

  return {
    stopToRequestMs: stopRenderer.stopRequestMs - stopRenderer.stopKeyMs,
    stopToFeedbackFrameMs: stopRenderer.stopFeedbackFrameMs - stopRenderer.stopKeyMs,
    stopToBackendEventMs: stopRenderer.terminalEventMs === null ? null : stopRenderer.terminalEventMs - stopRenderer.stopKeyMs,
    stopToSendReadyFrameMs: stopRenderer.sendReadyFrameMs - stopRenderer.stopKeyMs,
    stopToSettledFrameMs: stopRenderer.settledFrameMs - stopRenderer.stopKeyMs,
    stoppedReply: stopRenderer,
    followUp: { backend: followUp.result.backend, device: followUp.result.device, runtime, renderer: followUpRenderer },
  };
}

export async function measureUnloadAndReload(page, readStatus, modelId, { prompt, answer }) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = button("Send message");
  const unload = button("Unload model");
  const before = await readStatus();
  assert.equal(before.residentModel?.modelId, modelId);

  await composer.fill(prompt);
  await button("Chat settings").click();
  const unloaded = page.waitForResponse((response) => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/text/models/unload");
  await unload.click();
  const receipt = await unloaded;
  assert(receipt.ok(), `Model unload returned HTTP ${receipt.status()}.`);
  assert.equal((await receipt.json()).residentModel, null);
  const unloadRequestMs = receipt.request().timing().responseEnd;
  assert(Number.isFinite(unloadRequestMs) && unloadRequestMs >= 0);
  await expect(unload).toHaveCount(0);
  await expect(composer).toHaveValue(prompt);
  assert.equal((await readStatus()).residentModel, null);
  await button("Close chat settings").click();

  const timing = await observeChatReply(send);
  const request = page.waitForRequest((entry) => entry.method() === "POST" &&
    new URL(entry.url()).pathname === "/api/text/generate");
  await send.click();
  const { requestId } = (await request).postDataJSON();
  const reply = page.locator(`[data-chat-message=${JSON.stringify("response-" + requestId)}]`);
  await expect(reply.getByRole("button", { name: "More message actions", exact: true })).toBeVisible({ timeout });
  await expect(reply.locator(".text-message-content")).toContainText(answer, { timeout });
  const { job, residentModel } = await readStatus();
  assert.equal(job.status, "complete");
  assert.equal(job.id, requestId);
  assert.equal(job.modelId, modelId);
  assert.deepEqual(residentModel, before.residentModel, "Reload should restore the same model and engine configuration.");
  const { runtimeTiming: runtime, backend, device } = job.result;
  assert(Number.isFinite(runtime?.modelReadyMs), "Send after eviction should load a new model instance.");
  return { unloadRequestMs, reload: { backend, device, runtime, renderer: await readReplyTiming(timing) } };
}
