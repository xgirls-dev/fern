import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const connections = [];
let stream;
const model = { id: "local", name: "Local model", format: "gguf", installed: true };
const { page, state, close, errors } = await fixture({
  firstRun: true,
  textStatus: {
    models: [model], ggufAvailable: true, supportsJobEvents: true, supportsJobPolling: true,
    job: { id: null, status: "idle" },
  },
  textJobEvents: (request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    connections.push(new URL(request.url, "http://localhost").searchParams.get("jobId"));
    stream = response;
    const heartbeat = setInterval(() => response.write("data: {\"heartbeat\":true}\n\n"), 300);
    response.on("close", () => clearInterval(heartbeat));
  },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
const runningReply = page.getByRole("article", { name: "Response in progress", exact: true });
const partial = "The review is";
const answer = "The review is ready. Check the figures first.";
const draft = "Keep this next question.";
const polls = [];
let checking = false;

try {
  await page.route("**/api/text/job", async (route) => {
    const job = state.textStatus.job;
    if (!checking) return route.fulfill({ json: job });
    polls.push(job.status);
    if (polls.length === 1) return route.fulfill({ json: { ...job, id: "old-job", status: "complete" } });
    if (polls.length === 2) return route.fulfill({ status: 503, json: { error: "Temporary status failure" } });
    if (polls.length === 3) return route.fulfill({ json: { ...job, partialText: "An obsolete snapshot." } });
    return route.fulfill({ json: job });
  });
  await composer.fill("Review the worksheet.");
  await button("Send message").click();
  await expect.poll(() => connections.length).toBe(1);
  const running = { ...state.textStatus.job, phase: "Generating…", partialText: partial };
  state.textStatus.job = running;
  stream.write(`data: ${JSON.stringify({ job: running })}\n\n`);
  await expect(runningReply.locator(".text-message-content")).toHaveText(partial);
  await composer.fill(draft);
  const failedRead = page.waitForResponse((response) => response.url().endsWith("/api/text/job") && response.status() === 503,
    { timeout: 9_000 });
  checking = true;

  // Heartbeats keep the connection open, but they carry no reply or terminal state.
  await (await failedRead).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText("Reconnecting to the text runtime…", { exact: true })).toHaveCount(0);
  await expect.poll(() => polls.length, { timeout: 9_000 }).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(runningReply.locator(".text-message-content")).toHaveText(partial);

  state.textStatus.job = {
    ...running, status: "complete", partialText: answer, finishedAt: Date.now() / 1000,
    result: { inputTokens: 20, outputTokens: 10, generationSeconds: 1, tokensPerSecond: 10 },
  };
  const reply = page.getByRole("article", { name: "Model response", exact: true });
  await expect(reply.locator(".text-message-content")).toHaveText(answer, { timeout: 4_000 });
  await expect(button("Send message")).toBeEnabled();
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeFocused();
  assert.deepEqual(connections, [running.id]);
  assert.deepEqual(errors, []);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads.find(({ id }) => id === running.threadId)
    ?.messages.filter(({ role }) => role === "assistant").map(({ jobId, content }) => ({ jobId, content })))
    .toEqual([{ jobId: running.id, content: answer }]);
  console.log("A quiet stream settled from the matching runtime status without reconnecting or disturbing the draft.");
} finally {
  stream?.end();
  await close();
}
