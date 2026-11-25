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
        let firstEvent = null;
        let firstAnswerEvent = null;
        let terminalEvent = null;
        let feedback = null;
        let firstAnswerFrame = null;
        let stopClick = null;
        let sendReady = null;
        let settled = null;
        let lastFrame = sent;
        let maxFrameGap = 0;
        let animation;
        const watchdog = setTimeout(() => finish({ error: "The reply did not reach a settled frame." }), 360_000);

        function finish(value) {
          clearTimeout(watchdog);
          cancelAnimationFrame(animation);
          composer.removeEventListener("click", recordStop, true);
          if (window.EventSource === TimedEventSource) window.EventSource = NativeEventSource;
          resolve(value);
        }

        function recordStop(event) {
          if (event.target instanceof Element && event.target.closest('button[aria-label="Stop generation"]')) {
            stopClick ??= performance.now();
          }
        }
        if (measureStop) composer.addEventListener("click", recordStop, true);

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
          if (stopClick !== null && composer.querySelector('button[aria-label="Send message"]:enabled:not([aria-disabled="true"])')) {
            sendReady ??= now;
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
              ...(measureStop ? { stopClickMs: afterSend(stopClick), sendReadyFrameMs: afterSend(sendReady) } : {}),
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

export async function measureWarmStop(page, readJob, modelId) {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const stop = page.getByRole("button", { name: "Stop generation", exact: true });
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
  await stop.click();
  await expect(reply.getByText("Stopped · Partial response", { exact: true })).toBeVisible({ timeout });
  await expect(send).toBeEnabled({ timeout });
  await expect(composer).toHaveValue(followUpPrompt);
  const stopped = await readJob();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.id, running.id);
  assert(stopped.partialText?.trim(), "The stopped job should retain a partial answer.");
  const stopRenderer = await readReplyTiming(stoppedTiming);

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
    stopToBackendEventMs: stopRenderer.terminalEventMs === null ? null : stopRenderer.terminalEventMs - stopRenderer.stopClickMs,
    stopToSendReadyFrameMs: stopRenderer.sendReadyFrameMs - stopRenderer.stopClickMs,
    stopToSettledFrameMs: stopRenderer.settledFrameMs - stopRenderer.stopClickMs,
    stoppedReply: stopRenderer,
    followUp: { backend: followUp.result.backend, device: followUp.result.device, runtime, renderer: followUpRenderer },
  };
}
