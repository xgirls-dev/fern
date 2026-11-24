// Observe the actual renderer stream and frame callbacks without replacing replies.
export function observeChatReply(send) {
  return send.evaluateHandle((button) => {
    const result = new Promise((resolve) => {
      const feed = document.querySelector(".text-conversation");
      if (!feed) throw new Error("Open a chat before measuring a reply.");
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
        let lastFrame = sent;
        let maxFrameGap = 0;
        let animation;
        const watchdog = setTimeout(() => finish({ error: "The reply did not reach a settled frame." }), 360_000);

        function finish(value) {
          clearTimeout(watchdog);
          cancelAnimationFrame(animation);
          if (window.EventSource === TimedEventSource) window.EventSource = NativeEventSource;
          resolve(value);
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
                && !node.matches(".text-thinking, .text-stream-cursor, [data-chat-markdown-formatting]")))
              && node.textContent?.trim())) firstAnswerFrame = now;
            if (!reply.classList.contains("text-message--streaming") &&
                !content?.querySelector("[data-chat-markdown-formatting]")) {
              const afterSend = (at) => at === null ? null : at - sent;
              finish({
                feedbackFrameMs: afterSend(feedback),
                firstBackendEventMs: afterSend(firstEvent),
                firstAnswerEventMs: afterSend(firstAnswerEvent),
                firstAnswerFrameMs: afterSend(firstAnswerFrame),
                terminalEventMs: afterSend(terminalEvent),
                settledFrameMs: afterSend(now),
                maxFrameGapMs: maxFrameGap,
              });
              return;
            }
          }
          animation = requestAnimationFrame(frame);
        }
        animation = requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
    return { result };
  });
}
