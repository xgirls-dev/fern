import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", installed: true, format: "gguf", supportsReasoning: true, supportsVision: true };
const idle = { id: null, status: "idle" };
const { page, state, errors, close } = await fixture({ firstRun: true, builtRenderer: process.env.FERN_RESILIENCE_BUILT === "1", textStatus: {
  models: [model], ggufAvailable: true, supportsJobPolling: true, supportsPendingStop: true, job: idle,
} });

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const stream = page.locator(".text-message--streaming");
const conversation = page.getByRole("log", { name: "Conversation" });
const generate = (text) => { state.textStatus.job = { ...state.textStatus.job, partialText: text, phase: "Waiting for the first token…" }; };
const finish = (text, extra) => {
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: text, finishedAt: Date.now() / 1000, ...extra };
};

try {
  let jobPolls = 0;
  let admitRequest;
  let confirmPendingStop;
  let deferAdmission = false;
  const stops = [];
  const pendingStops = new Set();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/text/job", (route) => { jobPolls += 1; return route.fulfill({ json: state.textStatus.job }); });
  await page.route("**/api/text/generate", async (route) => {
    const request = route.request().postDataJSON();
    state.textRequests.push(request);
    if (deferAdmission) await new Promise((resolve) => { admitRequest = resolve; });
    if (pendingStops.has(request.requestId)) return route.fulfill({ status: 202, json: { textJob: {
      id: request.requestId, threadId: request.threadId, modelId: request.modelId, status: "stopped",
    } } });
    state.textStatus.job = { id: request.requestId, threadId: request.threadId, modelId: request.modelId,
      status: "running", partialText: "", phase: "Loading the GGUF model…", startedAt: Date.now() / 1000 };
    await route.fulfill({ status: 202, json: { textJob: state.textStatus.job } });
  });
  await page.route("**/api/text/stop", async (route) => {
    const request = route.request().postDataJSON();
    stops.push(request);
    if (request.threadId && request.requestId !== state.textStatus.job.id) {
      pendingStops.add(request.requestId);
      await new Promise((resolve) => { confirmPendingStop = resolve; });
      return route.fulfill({ status: 202, json: { cancelledBeforeStart: true } });
    }
    state.textStatus.job = { ...state.textStatus.job, status: "stopped" };
    await route.fulfill({ status: 202, json: { textJob: state.textStatus.job } });
  });
  const send = async (text) => { await composer.fill(text); await button("Send message").click(); };
  const active = () => page.locator(".text-header h2");

  deferAdmission = true;
  await send("Keep my conversation organized");
  await expect(stream).toContainText("Starting response…");
  await expect.poll(() => typeof admitRequest).toBe("function");
  admitRequest();
  deferAdmission = false;
  await expect(stream).toContainText("Loading model…");
  await stream.evaluate((row) => { row.dataset.originalNode = "true"; });
  state.textStatus.job.partialReasoning = "Arrange it by topic.";
  await stream.locator("summary").click();
  generate("Use a short descriptive title.");
  await expect(stream).toContainText("Use a short descriptive title.");
  assert(jobPolls > 0, "The chat should use the lightweight live status route");
  finish("Use a short descriptive title.");
  await expect(stream).toHaveCount(0);
  await expect(page.locator("[data-original-node] details")).toHaveAttribute("open", "");
  await expect(page.locator("[data-original-node]")).toContainText("Use a short descriptive title.");

  await button("Regenerate response").click();
  const sameReply = conversation.locator("[data-original-node]");
  await expect(stream).toContainText("Use a short descriptive title.");
  await expect(stream).toHaveAttribute("data-original-node", "true");
  await expect(conversation.getByRole("article")).toHaveCount(2);
  await expect(composer).toBeFocused();
  await expect.poll(() => state.textRequests.length).toBe(2);
  generate("The live replacement is being drafted.");
  await expect(sameReply).toContainText("The live replacement is being drafted.");
  await expect(sameReply).not.toContainText("Use a short descriptive title.");
  await page.keyboard.press("Control+f");
  const retrySearch = page.getByRole("searchbox", { name: "Search this chat" });
  await retrySearch.fill("descriptive title");
  await expect(sameReply).toContainText("Use a short descriptive title.");
  await expect(sameReply).toHaveAttribute("data-find-match", "true");
  await retrySearch.fill("live replacement");
  await expect(sameReply).toContainText("The live replacement is being drafted.");
  await expect(sameReply).toHaveAttribute("data-find-match", "true");
  await page.keyboard.press("Escape");
  await sameReply.locator(".text-message-content p").evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  finish("The searchable alternative answer.");
  await expect(sameReply).not.toHaveClass(/text-message--streaming/);
  await expect(sameReply).toContainText("The live replacement is being drafted.");
  const previous = button("Previous response version");
  const next = button("Next response version");
  await expect(previous).toBeEnabled();
  await previous.press("Enter");
  await expect(sameReply).toContainText("Use a short descriptive title.");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect(previous).toBeDisabled();
  await expect(previous).toBeFocused();
  await previous.press("Enter");
  await expect(sameReply).toContainText("Use a short descriptive title.");
  await next.press("Enter");
  await expect(sameReply).toContainText("The searchable alternative answer.");
  await expect(next).toBeDisabled();
  await expect(next).toBeFocused();

  await page.keyboard.press("Control+f");
  await page.getByRole("searchbox", { name: "Search this chat" }).fill("alternative answer");
  await expect(page.locator("[data-find-match]")).toContainText("The searchable alternative answer.");
  await page.keyboard.press("Escape");
  await expect(button("Find in chat")).toBeFocused();
  await button("Search threads").click();
  await page.getByRole("searchbox", { name: "Find a thread" }).fill("searchable alternative");
  await expect(page.getByRole("dialog").getByText("The searchable alternative answer.")).toBeVisible();
  await page.keyboard.press("Escape");

  await button("Edit message").click();
  await expect(page.getByRole("textbox", { name: "Edited prompt" })).toHaveValue("Keep my conversation organized");
  await button("Open branch draft").click();
  await expect(active()).toHaveText(/\(branch\)$/);
  await expect(composer).toHaveValue("Keep my conversation organized");
  await expect(composer).toBeFocused();
  await expect(conversation.getByRole("article")).toHaveCount(0);
  await button("Text thread: Keep my conversation organized").click();
  await expect(conversation.getByText("The searchable alternative answer.")).toBeVisible();

  const responseToRemove = conversation.getByRole("article", { name: "Model response" }).last();
  await chooseMessageAction(responseToRemove, "Delete reply");
  await expect(page.getByRole("group", { name: "Confirm message deletion" })).toContainText("Delete this reply and its other versions?");
  await page.keyboard.press("Escape");
  await expect(responseToRemove.getByRole("button", { name: "More message actions" })).toBeFocused();
  await chooseMessageAction(responseToRemove, "Delete reply");
  await button("Delete").click();
  await expect(conversation.getByRole("article")).toHaveCount(1);

  deferAdmission = true;
  admitRequest = undefined;
  await send("A new prompt after deleting a reply");
  await expect(stream).toContainText("Starting response…");
  await expect.poll(() => typeof admitRequest).toBe("function");
  await button("Stop generation").click();
  await expect(stream).toContainText("Stopping…");
  await expect(button("Stop generation")).toBeDisabled();
  await expect.poll(() => typeof confirmPendingStop).toBe("function");
  confirmPendingStop();
  await expect(conversation.getByText("Stopped before any text was generated")).toBeVisible();
  await expect(page.getByRole("status", { name: "Reply status" })).toHaveText("Response stopped.");
  await expect(composer).toBeFocused();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].requestId, state.textRequests.at(-1).requestId);
  assert.equal(stops[0].threadId, state.textRequests.at(-1).threadId);
  assert.deepEqual(state.textRequests.at(-1).messages.map((message) => message.content), ["A new prompt after deleting a reply"]);

  deferAdmission = false;
  await button("Retry response").click();
  await expect.poll(() => state.textRequests.length).toBe(4);
  const delayedReceipt = page.waitForResponse((response) => response.url().endsWith("/api/text/generate") &&
    response.request().postDataJSON().requestId === stops[0].requestId);
  admitRequest();
  await (await delayedReceipt).finished();
  generate("Partial response that survives a restart.");
  await expect(stream).toContainText("Partial response that survives a restart.");
  await composer.fill("A draft in the original thread");
  await page.keyboard.press("Control+n");
  await expect(composer).toBeFocused();
  await composer.fill("A draft in a second thread");
  await button("Open running chat").click();
  await expect(composer).toHaveValue("A draft in the original thread");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.some((thread) =>
    thread.pendingPreview?.content === "Partial response that survives a restart.")).toBe(true);
  state.textStatus.job = idle;
  await page.reload();
  await expect(conversation.getByText("The backend restarted. The partial response was recovered.")).toBeVisible();
  await expect(conversation.getByText("Partial response that survives a restart.")).toBeVisible();

  await button("Actions for text thread Keep my conversation organized").click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(active()).toHaveText(/\(copy\)$/);
  await expect(composer).toHaveValue("A draft in the original thread");
  const recentTurn = conversation.getByRole("article", { name: "Your message" }).last();
  await chooseMessageAction(recentTurn, "Delete message");
  await expect(page.getByRole("group", { name: "Confirm message deletion" })).toContainText("Delete this message and its reply?");
  await button("Delete").click();
  await expect(conversation.getByRole("article")).toHaveCount(1);
  await page.reload();
  await expect(conversation.getByRole("article")).toHaveCount(1);
  await button("Text thread: Keep my conversation organized").click();
  await expect(conversation.getByRole("article")).toHaveCount(3);

  await composer.fill("A long reply for the scroll test");
  await composer.press("Enter");
  await expect(stream).toBeVisible();
  const paragraphs = Array.from({ length: 70 }, (_, index) => `Paragraph ${index + 1} of the streaming reply.`).join("\n\n");
  generate(paragraphs);
  await expect(stream.getByText("Paragraph 70 of the streaming reply.")).toBeVisible();
  const scrollDistance = () => conversation.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect.poll(scrollDistance).toBeLessThan(10);
  await conversation.evaluate((element) => { element.scrollTop = 30; });
  await expect(button("Jump to latest message")).toBeVisible();
  generate(`${paragraphs}\n\nThe next part appears while reading above.`);
  await expect(stream).toContainText("The next part appears while reading above.");
  assert.equal(await conversation.evaluate((element) => element.scrollTop), 30);
  await button("Text thread: Keep my conversation organized (copy)").click();
  await button("Open running chat").click();
  assert.equal(await conversation.evaluate((element) => element.scrollTop), 30);
  await button("Jump to latest message").click();
  await expect.poll(scrollDistance).toBeLessThan(10);
  finish(`${paragraphs}\n\nThe next part appears while reading above.`);
  await expect(stream).toHaveCount(0);

  const attachment = `chat-image-${"a".repeat(32)}.png`;
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await page.route("**/api/text/images", (route) => route.fulfill({ json: { image: attachment } }));
  await page.route(`**/references/${attachment}`, (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(pixel, "base64") }));
  await composer.evaluate((input, png) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], "image.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, pixel);
  await expect(page.getByAltText("Image to send")).toBeVisible();
  await expect(composer).toHaveValue("");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.at(-1).messages.at(-1).image).toBe(attachment);
  assert.equal(state.textRequests.at(-1).messages.at(-1).content, "Describe this image.");
  assert.deepEqual(errors, []);
  console.log("Chat startup, cancellation before model admission, late-receipt isolation, streaming, versions, search, deletion, and restart recovery passed.");
} finally {
  await close();
}
