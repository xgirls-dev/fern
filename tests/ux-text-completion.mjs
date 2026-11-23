import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

let streamResponse;
let streamRequests = 0;
function sendFrame(frame) {
  streamResponse.write(`data: ${JSON.stringify(frame)}\n\n`);
}
const { page, state, close, errors } = await fixture({
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, supportsJobEvents: true, job: { id: null, status: "idle" },
  },
  textJobEvents: (request, response) => {
    const query = new URL(request.url, "http://fixture").searchParams;
    assert.equal(query.get("jobId"), state.textStatus.job.id);
    assert.equal(query.get("threadId"), state.textStatus.job.threadId);
    streamRequests++;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    streamResponse = response;
  },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const conversation = page.getByRole("log", { name: "Conversation" });
const reply = conversation.getByRole("article", { name: "Response in progress" });
const replyStatus = page.getByRole("status", { name: "Reply status" });
let releasePoll;
let holdNextPoll = false;
let polls = 0;

async function send(text) {
  await composer.fill(text);
  await button("Send message").click();
  await expect(reply).toBeVisible();
}

try {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.evaluate(() => {
    window.receivedTextAppends = 0;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if ("append" in JSON.parse(event.data)) window.receivedTextAppends++;
        });
      }
    };
  });
  await page.route("**/api/text/job", async (route) => {
    const snapshot = state.textStatus.job;
    polls++;
    if (holdNextPoll) {
      holdNextPoll = false;
      await new Promise((resolve) => { releasePoll = resolve; });
    }
    await route.fulfill({ json: snapshot }).catch(() => {});
  });
  holdNextPoll = true;
  await send("Finish this reply even when a status request is delayed.");
  await expect.poll(() => streamRequests).toBe(1);
  await expect.poll(() => typeof releasePoll).toBe("function");
  const firstRequest = state.textRequests.at(-1);
  sendFrame({ job: state.textStatus.job });
  sendFrame({ append: { phase: "Generating…", text: "Here is the start.", reasoning: "" } });
  await expect(reply).toContainText("Here is the start.");
  sendFrame({ heartbeat: true });
  sendFrame({ append: { phase: "Generating…", text: " Unicode: café ☕.", reasoning: "A brief explanation." } });
  await expect(reply).toContainText("Here is the start. Unicode: café ☕.");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  const burst = [" These", " deltas", " belong", " together."];
  for (const text of burst) sendFrame({ append: { phase: "Generating…", text, reasoning: "" } });
  await expect.poll(() => page.evaluate(() => window.receivedTextAppends)).toBe(2 + burst.length);
  await expect(reply.locator(".text-message-content p")).toHaveText(`Here is the start. Unicode: café ☕.${burst[0]}`);
  await page.clock.runFor(34);
  await expect(reply).toContainText(`Here is the start. Unicode: café ☕.${burst.join("")}`);
  await page.clock.resume();
  await reply.evaluate((row) => {
    row.dataset.completionReply = "true";
    const observer = new MutationObserver(() => {
      if (row.querySelector(".text-thinking")?.textContent === "Finishing response…") {
        observer.disconnect();
        row.dataset.intermediateCompletion = "true";
      } else if (!row.classList.contains("text-message--streaming")) observer.disconnect();
    });
    observer.observe(row, { childList: true, subtree: true, characterData: true, attributes: true });
  });
  const staleStatus = page.waitForResponse((response) => response.url().endsWith("/api/text/job"));
  releasePoll();
  await (await staleStatus).finished();
  const pollsBeforeCompletion = polls;
  await page.waitForTimeout(400);
  assert.equal(polls, pollsBeforeCompletion, "The status timer should not fetch while live updates are arriving.");
  state.textStatus.job = { ...state.textStatus.job, status: "complete",
    partialText: "Here is the start. This arrived through the completion request.", finishedAt: Date.now() / 1000 };
  sendFrame({ job: state.textStatus.job });
  streamResponse.end();
  await expect(reply).toHaveCount(0);
  const completedRow = conversation.locator("[data-completion-reply]");
  await expect(completedRow).toContainText("This arrived through the completion request.");
  await expect(completedRow).not.toHaveAttribute("data-intermediate-completion", "true");
  await expect(replyStatus).toHaveText("Reply ready.");
  await expect(button("Stop generation")).toHaveCount(0);
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === firstRequest.threadId)
    ?.messages.filter((message) => message.jobId === firstRequest.requestId).length).toBe(1);

  await send("Reconnect if the stream disconnects.");
  await expect.poll(() => streamRequests).toBe(2);
  sendFrame({ job: state.textStatus.job });
  sendFrame({ append: { phase: "Generating…", text: "Keep this partial response.", reasoning: "" } });
  await expect(reply).toContainText("Keep this partial response.");
  const pollsBeforeDisconnect = polls;
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  sendFrame({ append: { phase: "Generating…", text: " Keep the last", reasoning: "" } });
  sendFrame({ append: { phase: "Generating…", text: " delta too.", reasoning: "" } });
  streamResponse.end();
  await expect.poll(() => polls).toBeGreaterThan(pollsBeforeDisconnect);
  await expect(reply).toContainText("Keep this partial response. Keep the last delta too.");

  const polledText = "Keep this partial response. Keep the last delta too. Recovered through polling.";
  state.textStatus.job = { ...state.textStatus.job, partialText: polledText };
  await page.clock.runFor(200);
  await expect(reply).toContainText(polledText);
  assert.equal(streamRequests, 2, "Polling should fill the gap before the stream retries.");
  await page.clock.resume();
  await expect.poll(() => streamRequests).toBe(3);
  const reconnectedText = polledText + " The stream is back.";
  sendFrame({ job: { ...state.textStatus.job, phase: "Generating…", partialText: reconnectedText } });
  sendFrame({ append: { phase: "Generating…", text: " New deltas arrive live.", reasoning: "" } });
  await expect(reply.locator(".text-message-content p")).toHaveText(reconnectedText + " New deltas arrive live.");
  const pollsAfterReconnect = polls;
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  assert.equal(polls, pollsAfterReconnect, "Once live updates return, ordinary polling should stop.");

  state.textStatus.job = { ...state.textStatus.job, status: "complete",
    partialText: "This arrived through ordinary polling.", finishedAt: Date.now() / 1000 };
  streamResponse.end();
  await expect(reply).toHaveCount(0);
  await expect(conversation.getByText("This arrived through ordinary polling.")).toBeVisible();
  await page.clock.runFor(1500);
  assert.equal(streamRequests, 3, "A completed reply should cancel its pending reconnect.");
  await page.clock.resume();

  await send("Keep the most recent text when this reply stops.");
  await expect.poll(() => streamRequests).toBe(4);
  sendFrame({ job: state.textStatus.job });
  const stoppedReply = "This reply starts here.";
  sendFrame({ append: { phase: "Generating…", text: stoppedReply, reasoning: "" } });
  await expect(reply).toContainText(stoppedReply);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  const priorAppends = await page.evaluate(() => window.receivedTextAppends);
  const leading = " The last sentence";
  const queued = " is already in the stream.";
  sendFrame({ append: { phase: "Generating…", text: leading, reasoning: "" } });
  sendFrame({ append: { phase: "Generating…", text: queued, reasoning: "" } });
  await expect.poll(() => page.evaluate(() => window.receivedTextAppends)).toBe(priorAppends + 2);
  await expect(reply.locator(".text-message-content p")).toHaveText(stoppedReply + leading);
  state.textStatus.job = { ...state.textStatus.job, status: "stopped", partialText: stoppedReply, finishedAt: Date.now() / 1000 };
  sendFrame({ job: state.textStatus.job });
  streamResponse.end();
  await expect(reply).toHaveCount(0);
  await expect(conversation.getByText(stoppedReply + leading + queued)).toBeVisible();
  await page.clock.resume();

  await send("Find the completed reply after reloading the app.");
  await expect.poll(() => streamRequests).toBe(5);
  const reloadedRequest = state.textRequests.at(-1);
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === reloadedRequest.threadId)
    ?.pendingJobId).toBe(reloadedRequest.requestId);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Recovered the final reply on startup.",
    finishedAt: Date.now() / 1000 };
  await page.reload();
  await expect(conversation.getByText("Recovered the final reply on startup.")).toBeVisible();
  await expect(reply).toHaveCount(0);
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === reloadedRequest.threadId)
    ?.messages.filter((message) => message.jobId === reloadedRequest.requestId).length).toBe(1);
  assert.deepEqual(errors, []);
  console.log("Chat batches text, resumes live streaming after disconnect, and recovers completed replies through polling and reload.");
} finally {
  releasePoll?.();
  streamResponse?.end();
  await close();
}
