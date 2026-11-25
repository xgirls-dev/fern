import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture } from "./ui-fixture.mjs";

const models = [
  { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true },
  { id: "qwen", name: "Qwen", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true },
];
const document = { id: `doc-${"a".repeat(64)}`, name: "Research notes.txt", bytes: 35 };
const sharedImage = `chat-image-${"b".repeat(32)}.png`;
const photo = { name: "Shared photo.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") };
const uploads = [];
const { page, state, errors, dir, close } = await fixture({
  firstRun: true, imageCount: 0, threadCount: 0, viewport: { width: 1500, height: 900 },
  textStatus: { models, runtimeAvailable: true, ggufAvailable: true, imageToolModels: [{ id: "4b", label: "Klein 4B" }],
    job: { id: null, status: "idle" } },
  legacyTextWorkspace: {
    activeId: "text-thread-writing",
    threads: [
      { id: "text-thread-writing", title: "Writing draft", messages: [], modelId: "gemma" },
      { id: "text-thread-research", title: "Research sources", messages: [], modelId: "qwen", documents: [document] },
    ],
  },
});

const region = (name) => page.getByRole("region", { name, exact: true });
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const message = (root) => root.getByRole("textbox", { name: "Message", exact: true });
const findField = (root) => root.getByRole("searchbox", { name: "Search this chat", exact: true });
const highlights = () => page.evaluate(() => Array.from(CSS.highlights.get("fern-chat-find") ?? [], (range) => [
  range.startContainer.parentElement.closest("[data-chat-pane]")?.getAttribute("data-chat-pane"), range.toString(),
]).sort());
const left = region("Left chat");
const right = region("Right chat");
const divider = page.getByRole("separator", { name: "Resize chat panes", exact: true });
const choose = page.getByRole("dialog", { name: "Choose a chat", exact: true });
const complete = async (answer, pane) => {
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: answer,
    result: { inputTokens: 18, outputTokens: 4, generationSeconds: 1, tokensPerSecond: 4 } };
  await pane.getByText(answer, { exact: true }).waitFor();
};
const settings = (pane) => pane.getByRole("complementary", { name: "Chat settings panel", exact: true });
const searchFor = async (name) => {
  const query = choose.getByRole("searchbox", { name: "Find a chat" });
  await query.fill(name);
  await query.press("ArrowDown");
  await expect(choose.getByRole("button", { name: new RegExp(name) })).toBeFocused();
  await page.keyboard.press("Enter");
};

try {
  const openSplit = button("Open split chat", region("Text conversation"));
  await openSplit.click();
  await expect(choose.getByRole("searchbox", { name: "Find a chat" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(choose).toHaveCount(0);
  await expect(openSplit).toBeFocused();
  await openSplit.click();
  await searchFor("Research sources");
  await left.waitFor();
  await right.getByText(document.name, { exact: true }).waitFor();
  assert.equal(await left.getByText(document.name, { exact: true }).count(), 0);
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  assert(leftBox.x + leftBox.width <= rightBox.x, "The chats should appear in separate columns.");
  assert.equal(leftBox.y, rightBox.y);

  const modelMenu = page.getByRole("menu", { name: "Text model", exact: true });
  const rightModel = button("Text model: Qwen", right);
  const rightDraft = message(right);
  await rightDraft.fill("Keep this draft while choosing a model.");
  await rightDraft.evaluate((field) => field.setSelectionRange(5, 15, "backward"));
  await rightDraft.dispatchEvent("keydown", { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true, isComposing: true });
  await expect(modelMenu).toHaveCount(0);
  await rightDraft.press("Control+Shift+L");
  await expect(rightModel).toHaveAttribute("aria-expanded", "true");
  await expect(rightModel).toHaveAttribute("aria-keyshortcuts", "Control+Shift+L");
  await expect(button("Text model: Gemma", left)).toHaveAttribute("aria-expanded", "false");
  await expect(modelMenu.getByRole("menuitemradio", { name: "Qwen", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rightDraft).toBeFocused();
  assert.deepEqual(await rightDraft.evaluate((field) => [field.selectionStart, field.selectionEnd, field.selectionDirection]), [5, 15, "backward"]);

  await rightDraft.press("Control+Shift+L");
  await expect(modelMenu.getByRole("menuitemradio", { name: "Qwen", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(modelMenu.getByRole("menuitemradio", { name: "Gemma", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(button("Text model: Gemma", right)).toBeVisible();
  await expect(rightDraft).toBeFocused();
  await expect(rightDraft).toHaveValue("Keep this draft while choosing a model.");
  // Keep the opening animation pending until after keyboard navigation.
  const delayedMenu = await page.addStyleTag({ content: `
    @keyframes test-model-menu-opening { from { opacity: .99 } to { opacity: 1 } }
    .ui-model-menu[data-open] {
      animation: test-model-menu-opening 1s linear paused;
      animation-duration: 1s !important;
      animation-fill-mode: both;
    }
  ` });
  await rightDraft.press("Control+Shift+L");
  await expect(modelMenu.getByRole("menuitemradio", { name: "Gemma", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const nextModel = modelMenu.getByRole("menuitemradio", { name: "Qwen", exact: true });
  await expect(nextModel).toBeFocused();
  await modelMenu.evaluate(async (menu) => {
    const animations = menu.getAnimations();
    if (!animations.length) throw new Error("Expected a pending opening animation");
    for (const animation of animations) animation.finish();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(nextModel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rightModel).toBeVisible();
  await delayedMenu.evaluate((style) => style.remove());
  await rightDraft.press("Control+Shift+L");
  await message(left).click();
  await expect(modelMenu).toHaveCount(0);
  await expect(message(left)).toBeFocused();

  const dividerOffset = (percent) => () => divider.evaluate((element, ratio) => {
    const layout = element.parentElement.getBoundingClientRect();
    return Math.abs(element.getBoundingClientRect().left - (layout.left + layout.width * ratio / 100));
  }, percent);
  await expect(divider).toHaveAttribute("aria-controls", await page.locator('[data-chat-pane="primary"]').getAttribute("id"));
  await divider.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "35");
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "65");
  await expect.poll(dividerOffset(65)).toBeLessThan(1);
  await divider.dblclick();
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuetext", "55%");
  await expect.poll(dividerOffset(55)).toBeLessThan(1);
  const bar = await divider.boundingBox();
  const middleY = bar.y + bar.height / 2;
  await page.mouse.move(bar.x + bar.width / 2, middleY);
  await page.mouse.down();
  await page.mouse.move(bar.x - 65, middleY, { steps: 5 });
  await expect(divider).toHaveAttribute("data-resizing", "true");
  await expect.poll(dividerOffset(55)).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await expect(divider).not.toHaveAttribute("data-resizing");
  await expect.poll(dividerOffset(55)).toBeLessThan(1);

  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x - 65, bar.y + bar.height / 2, { steps: 7 });
  await page.waitForFunction(() => Number(document.querySelector(".chat-split-divider")?.getAttribute("aria-valuenow")) < 55);
  await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector(".chat-split-divider")?.getAttribute("aria-valuenow")) < 55);
  const savedSplit = Number(await divider.getAttribute("aria-valuenow"));
  assert(savedSplit >= 35 && savedSplit < 55);

  await button("Chat settings", left).click();
  await button("Chat settings", right).click();
  assert.notEqual(await settings(left).getAttribute("id"), await settings(right).getAttribute("id"));
  await settings(left).getByRole("spinbutton", { name: /^Context length/ }).fill("12345");
  await settings(right).getByRole("spinbutton", { name: /^Context length/ }).fill("23456");
  await button("Image", settings(left)).click();
  await settings(left).getByLabel("Width", { exact: true }).fill("320");
  await button("Image", settings(right)).click();
  await settings(right).getByLabel("Width", { exact: true }).fill("576");
  const widthIds = await Promise.all([settings(left), settings(right)].map((pane) => pane.getByLabel("Width", { exact: true }).getAttribute("id")));
  assert.notEqual(...widthIds);
  await button("Close chat settings", settings(left)).click();
  await button("Close chat settings", settings(right)).click();

  await page.route(`**/references/${sharedImage}`, (route) => route.fulfill({ contentType: "image/png", body: photo.buffer }));
  await page.route("**/api/text/images", async (route) => {
    const admission = Promise.withResolvers();
    const settled = Promise.withResolvers();
    uploads.push({ finish: admission.resolve, settled: settled.promise, body: route.request().postDataJSON() });
    await admission.promise;
    await route.fulfill({ status: 201, json: { image: sharedImage } }).catch(() => {});
    settled.resolve();
  });
  const attach = (pane) => pane.getByLabel("Chat image file", { exact: true }).setInputFiles(photo);
  const cancelAttach = (pane) => button("Cancel image attachment", pane);
  const draftImage = (pane) => pane.getByAltText("Image to send", { exact: true });
  await attach(left);
  await expect.poll(() => uploads.length).toBe(1);
  await attach(right);
  await expect.poll(() => uploads.length).toBe(2);
  await expect(cancelAttach(left)).toBeVisible();
  await expect(cancelAttach(right)).toBeVisible();
  await cancelAttach(left).click();
  await expect(cancelAttach(left)).toHaveCount(0);
  await expect(cancelAttach(right)).toBeVisible();
  await attach(left);
  await expect.poll(() => uploads.length).toBe(3);
  assert.deepEqual(uploads.map(({ body }) => body), Array(3).fill(uploads[0].body));
  uploads[0].finish();
  uploads[1].finish();
  await uploads[0].settled;
  await expect(draftImage(right)).toHaveAttribute("src", new RegExp(sharedImage));
  await expect(draftImage(left)).toHaveCount(0);
  await expect(cancelAttach(left)).toBeVisible();
  uploads[2].finish();
  await expect(draftImage(left)).toHaveAttribute("src", new RegExp(sharedImage));

  await message(left).fill("Continue the left draft");
  await message(right).fill("Answer the right prompt");
  await button("Send message", right).click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  const rightRequest = state.textRequests[0];
  assert.equal(rightRequest.threadId, "text-thread-research");
  assert.equal(rightRequest.contextSize, 23456);
  assert.equal(rightRequest.modelId, "qwen");
  assert.equal(rightRequest.imageSettings.width, 576);
  assert.deepEqual(rightRequest.documentIds, [document.id]);
  assert.equal(rightRequest.messages.at(-1).image, sharedImage);
  await button("Stop generation", right).waitFor();
  assert(await button("Send message", left).isDisabled());
  assert.equal(await message(left).inputValue(), "Continue the left draft");
  await message(left).press("Control+Shift+L");
  await expect(modelMenu).toHaveCount(0);
  await expect(message(left)).toBeFocused();
  await complete("Right answer.", right);

  await button("Send message", left).click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  const leftRequest = state.textRequests[1];
  assert.equal(leftRequest.threadId, "text-thread-writing");
  assert.equal(leftRequest.contextSize, 12345);
  assert.equal(leftRequest.modelId, "gemma");
  assert.equal(leftRequest.imageSettings.width, 320);
  assert.equal(leftRequest.documentIds, undefined);
  assert.equal(leftRequest.messages.at(-1).image, sharedImage);
  await complete("Left answer.", left);

  await button("Find in chat", left).click();
  await findField(left).fill("Left answer");
  await expect.poll(highlights).toEqual([["primary", "Left answer"]]);
  await button("Find in chat", right).click();
  await findField(right).fill("Right answer");
  await expect.poll(highlights).toEqual([["primary", "Left answer"], ["secondary", "Right answer"]]);

  await message(right).press("Control+f");
  await expect(findField(right)).toBeFocused();
  assert.deepEqual(await findField(right).evaluate((element) => [element.selectionStart, element.selectionEnd]), [0, 12]);
  await page.setViewportSize({ width: 864, height: 620 });
  await left.waitFor({ state: "hidden" });
  await expect.poll(highlights).toEqual([["secondary", "Right answer"]]);
  const paneSwitcher = page.getByRole("group", { name: "Chat panes", exact: true });
  await button("Left chat", paneSwitcher).click();
  await expect(findField(left)).toHaveValue("Left answer");
  await expect.poll(highlights).toEqual([["primary", "Left answer"]]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(highlights).toEqual([["primary", "Left answer"], ["secondary", "Right answer"]]);
  await findField(right).press("Escape");
  await expect(button("Find in chat", right)).toBeFocused();
  await expect.poll(highlights).toEqual([["primary", "Left answer"]]);
  await button("Close find", left).click();
  await expect.poll(highlights).toEqual([]);

  await chooseMessageAction(left.getByRole("article", { name: "Model response" }), "Delete reply");
  await button("Delete", left.getByRole("group", { name: "Confirm message deletion" })).click();
  await chooseMessageAction(right.getByRole("article", { name: "Your message" }), "Delete message");
  await button("Delete", right.getByRole("group", { name: "Confirm message deletion" })).click();
  await expect(button("Undo deletion", left)).toHaveAccessibleDescription("Reply deleted.");
  await expect(button("Undo deletion", right)).toHaveAccessibleDescription("Message and reply deleted.");
  await button("Undo deletion", left).click();
  await button("Undo deletion", right).click();
  await page.reload();
  await right.getByText("Right answer.", { exact: true }).waitFor();
  await left.getByText("Left answer.", { exact: true }).waitFor();
  await expect(left.getByAltText("Attached chat image", { exact: true })).toHaveAttribute("src", new RegExp(sharedImage));
  await expect(right.getByAltText("Attached chat image", { exact: true })).toHaveAttribute("src", new RegExp(sharedImage));
  assert.equal(Number(await divider.getAttribute("aria-valuenow")), savedSplit);
  await page.screenshot({ path: `${dir}/chat-split-wide.png` });
  await page.setViewportSize({ width: 864, height: 620 });
  const switcher = page.getByRole("group", { name: "Chat panes", exact: true });
  await button("Right chat", switcher).click();
  await left.waitFor({ state: "hidden" });
  await right.getByText("Right answer.", { exact: true }).waitFor();
  await expect(button("Choose another chat for this pane", right)).toBeVisible();
  await expect(button("Open text thread", right)).toHaveCount(0);
  await button("Left chat", switcher).click();
  await right.waitFor({ state: "hidden" });
  await left.getByText("Left answer.", { exact: true }).waitFor();

  await page.setViewportSize({ width: 1500, height: 900 });
  await button("Close pane", right).click();
  await region("Text conversation").getByText("Left answer.", { exact: true }).waitFor();
  const research = button("Text thread: Research sources");
  const canvas = page.locator(".chat-split-layout");
  await research.dragTo(canvas, { targetPosition: { x: 70, y: 225 } });
  await left.getByText("Right answer.", { exact: true }).waitFor();
  await right.getByText("Left answer.", { exact: true }).waitFor();

  await button("Choose another chat for this pane", right).click();
  await button("New chat in this pane", choose).click();
  await right.getByRole("heading", { name: "New text thread", exact: true }).waitFor();
  await left.getByText("Right answer.", { exact: true }).waitFor();
  await button("Close pane", left).click();
  await region("Text conversation").getByRole("heading", { name: "New text thread", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Split chats preserve independent Find, drafts, shared attachments, settings, responses, and Undo through pane changes and reload.");
} finally {
  for (const upload of uploads) upload.finish();
  await close();
}
