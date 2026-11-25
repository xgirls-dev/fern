import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_CONNECTION_BUILT === "1",
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const stream = page.getByRole("article", { name: "Response in progress" });
const composerStatus = page.locator(".text-composer-hint [role=status]");
const replyStatus = page.getByRole("status", { name: "Reply status" });
const receipts = [];
const stops = [];
let pollingOffline = false;
let holdAdmission = false;
let shortenedStoppedReasoning;
let admitRequest;
let holdStopFailure = false;
let rejectStop;

const send = async (text) => { await composer.fill(text); await button("Send message").click(); };
const release = (index) => receipts[index]?.();

try {
  await page.route("**/api/text/job", (route) => pollingOffline
    ? route.abort()
    : route.fulfill({ json: state.textStatus.job }));
  await page.route("**/api/text/generate", async (route) => {
    const request = route.request().postDataJSON();
    state.textRequests.push(request);
    if (holdAdmission) await new Promise((resolve) => { admitRequest = resolve; });
    const textJob = {
      id: request.requestId, threadId: request.threadId, modelId: request.modelId,
      status: "running", phase: "Loading the GGUF model…", partialText: "", startedAt: Date.now() / 1000,
    };
    state.textStatus.job = textJob;
    await new Promise((resolve) => receipts.push(resolve));
    await route.fulfill({ status: 202, json: { textJob } });
  });
  await page.route("**/api/text/stop", async (route) => {
    stops.push(route.request().postDataJSON().requestId);
    if (holdStopFailure) {
      await new Promise((resolve) => { rejectStop = resolve; });
      await route.fulfill({ status: 503, json: { error: "The runtime could not accept the Stop request." } });
      return;
    }
    if (stops.at(-1) === state.textStatus.job.id) {
      state.textStatus.job = { ...state.textStatus.job, status: "stopped", finishedAt: Date.now() / 1000,
        ...(shortenedStoppedReasoning ? { partialText: "", partialReasoning: shortenedStoppedReasoning } : {}) };
    }
    await route.fulfill({ status: 202, json: { textJob: state.textStatus.job } });
  });

  holdAdmission = true;
  await send("Keep the first response connected");
  await expect.poll(() => typeof admitRequest).toBe("function");
  await expect(stream).toContainText("Starting response…");
  assert.equal(receipts.length, 0);
  assert.deepEqual(stops, []);
  await button("New chat").click();
  await expect(composerStatus).toHaveText("A response is starting in another chat");
  await button("Open running chat").click();
  await expect(stream).toContainText("Starting response…");
  admitRequest();
  holdAdmission = false;
  await expect(stream).toContainText("Loading model…");
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…" };
  await expect(stream).toContainText("Waiting for the first token…");
  await stream.evaluate((row) => { row.dataset.connectedReply = "true"; });
  state.textStatus.job = { ...state.textStatus.job, partialReasoning: "Start with a concise observation." };
  const reasoning = stream.locator("summary");
  await expect(reasoning).toHaveText("Reasoning…");
  await expect(stream.getByText("Reasoning…", { exact: true })).toHaveCount(1);
  await reasoning.click();
  await expect(stream.getByText("Start with a concise observation.")).toBeVisible();
  const first = "The first tokens stay on screen.";
  state.textStatus.job = { ...state.textStatus.job, partialText: first };
  await expect(stream).toContainText(first);
  await expect(composerStatus).toHaveText("Responding…");
  await expect(reasoning).toHaveText("Reasoning");

  state.textStatus.job = { ...state.textStatus.job, phase: "Generating an image…", partialText: "The first", partialReasoning: "Start with" };
  await expect(stream.getByText("Creating an image…", { exact: true })).toBeVisible();
  await expect(stream).toContainText(first);
  await expect(stream.getByText("Start with a concise observation.")).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…" };
  await expect(composerStatus).toHaveText("Responding…");

  pollingOffline = true;
  await expect(composerStatus).toHaveText("Reconnecting to the text runtime…");
  await expect(stream.getByText("Reconnecting to the text runtime…", { exact: true })).toBeVisible();
  await expect(stream).toContainText(first);
  await expect(page.getByRole("alert")).toHaveCount(0);
  pollingOffline = false;
  await button("Stop generation").focus();
  await expect(button("Stop generation")).toBeFocused();
  const complete = `${first} The same response finishes after reconnecting.`;
  state.textStatus.job = { ...state.textStatus.job, partialText: complete, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(page.locator("[data-connected-reply]")).toContainText(complete);
  await expect(stream).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composerStatus).toBeEmpty();
  await expect(replyStatus).toHaveText("Reply ready.");
  await expect(replyStatus).toHaveAttribute("aria-atomic", "true");
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveAttribute("aria-live", "off");

  await button("New chat").click();
  await expect(replyStatus).toBeEmpty();
  await button("Text thread: Keep the first response connected").click();
  await expect(replyStatus).toBeEmpty();

  await send("Stop the next response before either receipt returns");
  await expect(stream).toContainText("Loading model…");
  const nextId = state.textRequests[1].requestId;
  await stream.evaluate((row) => {
    const observer = new MutationObserver(() => {
      if (row.textContent.includes("Starting response…")) row.dataset.loadingRegressed = "true";
    });
    observer.observe(row, { subtree: true, childList: true, characterData: true });
  });
  const lateReceipt = page.waitForResponse((response) => response.url().endsWith("/api/text/generate") &&
    response.request().postDataJSON().requestId === state.textRequests[0].requestId);
  release(0);
  await (await lateReceipt).finished();
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…" };
  await expect(stream).toContainText("Waiting for the first token…");
  await expect(stream).not.toHaveAttribute("data-loading-regressed");
  await expect(stream).toHaveAttribute("data-chat-message", `response-${nextId}`);
  pollingOffline = true;
  await expect(composerStatus).toHaveText("Reconnecting to the text runtime…");
  await button("Stop generation").click();
  await expect(composer).toBeFocused();
  await expect(composerStatus).toHaveText("Reconnecting to stop…");
  assert.deepEqual(stops, []);
  pollingOffline = false;
  await expect.poll(() => stops).toEqual([nextId]);
  await expect(stream).toHaveCount(0);
  await expect(page.getByText("Stopped before any text was generated")).toBeVisible();
  await expect(replyStatus).toHaveText("Response stopped.");
  release(1);
  await expect(stream).toHaveCount(0);

  await send("Stop after the model starts reasoning");
  await expect(stream).toContainText("Loading model…");
  const reasoningOnly = "The reasoning stays available when the model stops.";
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialReasoning: reasoningOnly };
  await stream.locator("summary").click();
  await expect(stream.getByText(reasoningOnly)).toBeVisible();
  const stoppedId = state.textStatus.job.id;
  const stoppedReply = page.locator(`[data-chat-message="response-${stoppedId}"]`);
  shortenedStoppedReasoning = "The reasoning";
  await button("Stop generation").click();
  await expect(stoppedReply).toContainText("Stopped during reasoning");
  await expect(stoppedReply.getByText(reasoningOnly)).toBeVisible();
  await expect(replyStatus).toHaveText("Response stopped. Partial reply available.");
  release(2);

  await send("Keep the visible response if the final answer is empty");
  await expect(stream).toContainText("Loading model…");
  const partial = "The answer began before the runtime returned an empty result.";
  state.textStatus.job = { ...state.textStatus.job, partialText: partial, phase: "Waiting for the first token…" };
  await expect(stream.getByText(partial)).toBeVisible();
  await stream.evaluate((row) => { row.dataset.incompleteReply = "true"; });
  const incompleteId = state.textStatus.job.id;
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "", finishedAt: Date.now() / 1000 };
  const incomplete = page.locator("[data-incomplete-reply]");
  await expect(incomplete.getByText("The model finished without a final answer. The partial response was kept.")).toBeVisible();
  await expect(incomplete.getByText(partial)).toBeVisible();
  await expect(replyStatus).toHaveText("Response incomplete. Partial reply available.");
  const recovery = incomplete.locator(".ui-inline-notice");
  await expect(recovery.getByRole("button", { name: "Continue response", exact: true })).toBeVisible();
  const retry = recovery.getByRole("button", { name: "Retry response", exact: true });
  await expect(retry).toBeVisible();
  release(3);
  await expect.poll(async () => {
    const workspace = await savedTextWorkspace(page);
    const messages = workspace.threads.find((thread) => thread.id === workspace.activeId).messages;
    return messages.find((message) => message.jobId === incompleteId)?.content;
  }).toBe(partial);
  await retry.press("Enter");
  await expect(composer).toBeFocused();
  await expect(stream).toBeVisible();
  await expect(replyStatus).toBeEmpty();
  await button("Find in chat").click();
  const search = page.getByRole("searchbox", { name: "Search this chat" });
  await expect(search).toBeFocused();
  state.textStatus.job = { ...state.textStatus.job, status: "failed", error: "The local runtime could not finish.", finishedAt: Date.now() / 1000 };
  await expect(replyStatus).toHaveText("Response failed. Details are in the reply.");
  await expect(search).toBeFocused();
  release(4);

  await send("Keep Stop recovery with the running chat");
  await expect(stream).toContainText("Loading model…");
  holdStopFailure = true;
  await button("Stop generation").click();
  await expect.poll(() => typeof rejectStop).toBe("function");
  await button("New chat").click();
  await expect(composerStatus).toHaveText("A response is running in another chat");
  const stopFailure = page.getByRole("alert").filter({ hasText: "The runtime could not accept the Stop request." });
  const stoppedRequest = page.waitForResponse((response) => response.url().endsWith("/api/text/stop") && response.status() === 503);
  rejectStop();
  await (await stoppedRequest).finished();
  await expect(stopFailure).toHaveCount(0);
  await button("Open running chat").click();
  await expect(stopFailure).toBeVisible();
  await expect(button("Stop generation")).toBeEnabled();

  rejectStop = undefined;
  await button("Try stopping again").press("Enter");
  await expect(composer).toBeFocused();
  await expect(stopFailure).toHaveCount(0);
  await expect.poll(() => typeof rejectStop).toBe("function");
  assert.deepEqual(stops.slice(-2), [state.textStatus.job.id, state.textStatus.job.id]);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Finished before the Stop response.", finishedAt: Date.now() / 1000 };
  await expect(replyStatus).toHaveText("Reply ready.");
  const lateStop = page.waitForResponse((response) => response.url().endsWith("/api/text/stop") && response.status() === 503);
  rejectStop();
  await (await lateStop).finished();
  await expect(stopFailure).toHaveCount(0);
  release(5);
  assert.deepEqual(errors, []);
  console.log("Slow receipts, staged progress, connection recovery, partial output, reply announcements, and keyboard focus through stop and retry passed.");
} finally {
  admitRequest?.();
  rejectStop?.();
  receipts.forEach((resolve) => resolve());
  await close();
}
