import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture } from "./ui-fixture.mjs";

const id = "text-thread-long-history";
const otherId = "text-thread-short-history";
const thresholdId = "text-thread-window-threshold";
const messages = Array.from({ length: 420 }, (_, index) => ({
  id: `row-${index}`, role: index % 2 ? "assistant" : "user", createdAt: index + 1,
  content: index % 2
    ? `## Reply ${index}\n\n${"A self-contained paragraph to test a long conversation. ".repeat(14)}\n\n- Save the result.\n- Keep the notes.`
    : `Prompt ${index}`,
}));
messages[211].alternatives = [{ id: "old-211", role: "assistant", content: "The earlier revision mentions a silver lantern.", createdAt: 211 }];

const { page, state, errors, close } = await fixture({ builtRenderer: process.env.FERN_SCALE_BUILT === "1", firstRun: true, legacyTextWorkspace: { activeId: id, threads: [
  { id, title: "Long transcript", modelId: "local", messages },
  { id: otherId, title: "Short transcript", modelId: "local", draft: "A separate draft", messages: [] },
  { id: thresholdId, title: "Threshold transcript", modelId: "local", messages: messages.slice(0, 72) },
] }, textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }], ggufAvailable: true, job: { id: null, status: "idle" } } });

const feed = page.getByRole("log", { name: "Conversation" });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const rows = feed.locator(".text-message");
const button = (name) => page.getByRole("button", { name, exact: true });
const row = (id) => feed.locator(`[data-chat-message="${id}"]`);
const visiblePosition = (message) => message.evaluate((element) => {
  const feedElement = element.closest(".text-conversation");
  if (!feedElement) return false;
  const bounds = element.getBoundingClientRect();
  const viewport = feedElement.getBoundingClientRect();
  return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
});

async function find(query) {
  await page.keyboard.press("Control+f");
  await page.getByRole("searchbox", { name: "Search this chat" }).fill(query);
  const match = feed.locator("[data-find-match]");
  await expect(match).toHaveCount(1);
  await expect.poll(() => visiblePosition(match)).toBe(true);
  return match;
}

try {
  await expect(row("row-419")).toBeVisible();
  await expect.poll(() => visiblePosition(row("row-419"))).toBe(true);
  const settledMountCount = await rows.count();
  assert(settledMountCount <= 96, `The latest view mounted ${settledMountCount} of ${messages.length} messages`);
  assert.equal(await row("row-211").count(), 0);

  await feed.focus();
  await feed.press("Home");
  await expect(row("row-0")).toBeVisible();
  await expect.poll(() => visiblePosition(row("row-0"))).toBe(true);
  assert((await rows.count()) <= 96);

  const comparison = await find("silver lantern");
  await expect(comparison).toContainText("The earlier revision mentions a silver lantern.");
  await expect(comparison).toContainText("Chat uses version 2");
  await page.keyboard.press("Escape");
  await expect(row("row-211")).toContainText("Reply 211");

  const watchedPages = await page.evaluateHandle(() => {
    const observe = IntersectionObserver.prototype.observe;
    const observed = [];
    IntersectionObserver.prototype.observe = function (target) {
      if (target.hasAttribute("data-chat-page")) observed.push(Number(target.dataset.chatPage));
      observe.call(this, target);
    };
    return () => {
      IntersectionObserver.prototype.observe = observe;
      return observed;
    };
  });
  await composer.fill("Continue the long conversation");
  await button("Send message").click();
  const stream = feed.locator(".text-message--streaming");
  await expect(stream).toBeVisible();
  assert.deepEqual(await watchedPages.evaluate((stopWatching) => stopWatching()), [35],
    "Sending at a page boundary should observe only the new transcript page");
  await watchedPages.dispose();
  await stream.evaluate((element) => { element.dataset.streamingNode = "true"; });
  const match = await find("Prompt 96");
  await expect(match).toContainText("Prompt 96");
  await page.keyboard.press("Escape");
  const early = row("row-96");
  await expect.poll(() => visiblePosition(early)).toBe(true);
  const topOfEarly = () => early.evaluate((element) => element.getBoundingClientRect().top);
  const before = await topOfEarly();
  state.textStatus.job = { ...state.textStatus.job, partialText: "Streaming below the viewport.\n\n".repeat(34) };
  await expect(stream).toContainText("Streaming below the viewport.");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The new reply is complete.", finishedAt: Date.now() / 1000 };
  await expect(feed.locator("[data-streaming-node]")).toContainText("The new reply is complete.");
  await expect(stream).toHaveCount(0);
  assert(Math.abs(await topOfEarly() - before) < 3, "A response that finishes below the viewport must preserve the reader's position");

  await button("Text thread: Short transcript").click();
  await expect(composer).toHaveValue("A separate draft");
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ ...originalViewport, width: 930 });
  await button("Text thread: Long transcript").click();
  await expect(early).toBeAttached();
  await expect.poll(() => visiblePosition(early)).toBe(true);
  await expect.poll(async () => Math.abs(await topOfEarly() - before)).toBeLessThan(8);
  await page.setViewportSize(originalViewport);
  await button("Jump to latest message").click();
  const finalReply = feed.getByText("The new reply is complete.");
  await expect.poll(() => visiblePosition(finalReply)).toBe(true);
  assert((await rows.count()) <= 96);

  const latestReply = feed.getByRole("article", { name: "Model response" }).last();
  await latestReply.evaluate((element) => { element.dataset.regeneratedNode = "true"; });
  await button("Regenerate response").click();
  await expect(stream).toHaveAttribute("data-regenerated-node", "true");
  await expect(stream).toContainText("The new reply is complete.");
  await expect.poll(() => state.textStatus.job.status).toBe("running");
  const followUp = "An unsent follow-up while the reply regenerates.";
  await composer.fill(followUp);
  await composer.evaluate((field) => field.setSelectionRange(3, 9));
  state.textStatus.job = { ...state.textStatus.job, partialText: "A revised answer is streaming." };
  await expect(stream).toContainText("A revised answer is streaming.");
  await expect(composer).toBeFocused();
  assert.deepEqual(await composer.evaluate((field) => [field.selectionStart, field.selectionEnd]), [3, 9]);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The revised answer is complete.", finishedAt: Date.now() / 1000 };
  await expect(stream).toHaveCount(0);
  await expect(feed.locator("[data-regenerated-node]")).toContainText("The revised answer is complete.");
  await expect(composer).toHaveValue(followUp);

  await find("Prompt 16");
  await page.keyboard.press("Escape");
  await row("row-16").getByRole("button", { name: "Edit message" }).click();
  const edit = page.getByRole("textbox", { name: "Edited prompt" });
  await edit.fill("An unfinished edit in the earlier history");
  await edit.evaluate((field) => field.setSelectionRange(3, 12, "backward"));
  await composer.focus();
  await button("Resume prompt edit").click();
  await expect(edit).toBeFocused();
  assert.deepEqual(await edit.evaluate((field) => [field.selectionStart, field.selectionEnd, field.selectionDirection]), [3, 12, "backward"]);
  await button("Jump to latest message").click();
  await expect(edit).toHaveCount(0);
  await button("Resume prompt edit").click();
  await expect(edit).toHaveValue("An unfinished edit in the earlier history");
  await expect(edit).toBeFocused();
  assert.deepEqual(await edit.evaluate((field) => [field.selectionStart, field.selectionEnd, field.selectionDirection]), [3, 12, "backward"]);
  await expect.poll(() => visiblePosition(edit)).toBe(true);
  await page.keyboard.press("Escape");
  await find("Prompt 240");
  await page.keyboard.press("Escape");
  await chooseMessageAction(row("row-240"), "Delete message");
  await expect(page.getByRole("group", { name: "Confirm message deletion" })).toContainText("Delete this message and its reply?");
  await button("Delete").click();
  await expect(row("row-240")).toHaveCount(0);
  await expect(row("row-241")).toHaveCount(0);
  await expect.poll(() => visiblePosition(row("row-242"))).toBe(true);
  await button("Jump to latest message").click();
  await expect(row("row-240")).toHaveCount(0);
  await button("Undo deletion").click();
  await expect(row("row-240")).toBeFocused();
  await expect.poll(() => visiblePosition(row("row-240"))).toBe(true);
  await expect(row("row-241")).toContainText("Reply 241");

  await chooseMessageAction(row("row-240"), "Delete message");
  await button("Delete").click();
  await expect(row("row-240")).toHaveCount(0);
  await expect.poll(() => visiblePosition(row("row-242"))).toBe(true);
  const beforeDismiss = await row("row-242").evaluate((element) => element.getBoundingClientRect().top);
  await button("Dismiss deletion notice").click();
  await expect(row("row-242")).toBeFocused();
  assert(Math.abs(await row("row-242").evaluate((element) => element.getBoundingClientRect().top) - beforeDismiss) < 3,
    "Dismissing Undo should return focus to the surviving message without moving the transcript");

  await button("Text thread: Threshold transcript").click();
  const thresholdRow = row("row-71");
  await expect(thresholdRow).toBeVisible();
  await thresholdRow.evaluate((element) => { element.dataset.thresholdRow = "true"; });
  await composer.fill("Cross the transcript threshold");
  await button("Send message").click();
  await expect(stream).toBeVisible();
  await expect(thresholdRow).toHaveAttribute("data-threshold-row", "true");
  await expect.poll(() => state.textStatus.job.status).toBe("running");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The threshold reply.", finishedAt: Date.now() / 1000 };
  await expect(stream).toHaveCount(0);
  await expect(thresholdRow).toHaveAttribute("data-threshold-row", "true");
  const newPrompt = feed.getByRole("article", { name: "Your message" }).filter({ hasText: "Cross the transcript threshold" });
  await chooseMessageAction(newPrompt, "Delete message");
  await button("Delete").click();
  await expect(newPrompt).toHaveCount(0);
  await expect(rows).toHaveCount(72);
  await expect(thresholdRow).toHaveAttribute("data-threshold-row", "true");
  await button("Undo deletion").click();
  await expect(newPrompt).toBeVisible();
  await expect(thresholdRow).toHaveAttribute("data-threshold-row", "true");
  assert.deepEqual(errors, []);
  console.log(`Long chat mounted ${settledMountCount} of ${messages.length} messages. Scroll, search, streaming, edits, deletion, and crossing the window threshold passed.`);
} finally {
  await close();
}
