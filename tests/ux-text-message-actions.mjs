import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const id = "text-thread-message-actions";
const otherId = "text-thread-message-actions-other";
const reply = (id, content, createdAt) => ({ id, role: "assistant", content, createdAt, status: "complete", modelName: "Local model",
  metrics: { inputTokens: 25, outputTokens: 12, generationSeconds: 1, tokensPerSecond: 12, backend: "Vulkan" } });
const { page, close, dir, errors } = await fixture({
  builtRenderer: process.env.FERN_MESSAGE_ACTIONS_BUILT === "1",
  firstRun: true,
  viewport: { width: 864, height: 600 },
  legacyTextWorkspace: { activeId: id, threads: [
    { id, title: "Message actions", modelId: "local", messages: [
      { id: "prompt-one", role: "user", content: "Explain your first idea", createdAt: 1 },
      reply("reply-one", "Here is an idea for later.", 2),
      { id: "prompt-two", role: "user", content: "Give me another idea", createdAt: 3 },
      reply("reply-two", "Here is a second idea.", 4),
    ] },
    { id: otherId, title: "Another chat", modelId: "local", draft: "A different draft", messages: [] },
  ] },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, job: { id: null, status: "idle" } },
});
const conversation = page.getByRole("log", { name: "Conversation" });
const row = (id) => conversation.locator(`[data-chat-message="${id}"]`);
const more = (id) => row(id).getByRole("button", { name: "More message actions", exact: true });
const item = (name) => page.getByRole("menuitem", { name, exact: true });
const menu = page.getByRole("menu", { name: "Message actions", exact: true });
const confirmation = page.getByRole("group", { name: "Confirm message deletion" });
const button = (name) => page.getByRole("button", { name, exact: true });

async function openMenu(id) {
  await more(id).click();
  await expect(menu).toBeVisible();
}

try {
  const olderCopy = row("reply-one").getByRole("button", { name: "Copy message" });
  const olderSpeed = row("reply-one").locator(".text-response-speed");
  const latestSpeed = row("reply-two").locator(".text-response-speed");
  await olderCopy.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(olderCopy).toHaveCSS("opacity", "0");
  await expect(olderSpeed).toHaveCSS("visibility", "hidden");
  await expect(latestSpeed).toBeVisible();
  await expect(more("reply-two")).toHaveCSS("opacity", "1");
  const quietRow = await row("reply-one").boundingBox();
  assert(quietRow);
  await page.mouse.move(quietRow.x + quietRow.width / 2, quietRow.y + quietRow.height / 2);
  await expect(olderCopy).toHaveCSS("opacity", "1");
  await expect(olderSpeed).toBeVisible();
  assert.deepEqual(await row("reply-one").boundingBox(), quietRow, "Revealing actions should keep the transcript layout stable");
  await page.mouse.move(0, 0);
  await expect(olderCopy).toHaveCSS("opacity", "0");
  await expect(olderSpeed).toHaveCSS("visibility", "hidden");
  const device = await page.context().newCDPSession(page);
  await device.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await expect(olderCopy).toHaveCSS("opacity", "1");
  await expect(olderSpeed).toBeVisible();
  await device.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await device.detach();
  await expect(row("prompt-one").getByRole("button", { name: "Edit message" })).toBeVisible();
  const prompt = row("prompt-one");
  const bubble = await prompt.locator(".text-user-bubble").boundingBox();
  const tools = await prompt.locator(".text-message-tools").boundingBox();
  assert(bubble && tools && bubble.y + bubble.height <= tools.y, "Prompt tools should sit below the bubble");
  await expect(row("reply-two").getByRole("button", { name: "Regenerate response" })).toBeVisible();
  await expect(button("Delete reply")).toHaveCount(0);
  await expect(menu).toHaveCount(0);

  await more("reply-one").focus();
  await expect(olderCopy).toHaveCSS("opacity", "1");
  await expect(olderSpeed).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(more("reply-one")).toHaveAttribute("aria-expanded", "true");
  await expect(item("Branch from response")).toBeFocused();
  await page.keyboard.press("End");
  await expect(item("Delete reply")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Branch from response")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Response details")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row("reply-one").getByText(/Vulkan/)).toBeVisible();
  await expect(more("reply-one")).toBeFocused();
  await expect(menu).toHaveCount(0);

  await page.keyboard.press("ArrowUp");
  await expect(item("Delete reply")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more("reply-one")).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(item("Branch from response")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(more("reply-one")).not.toBeFocused();

  const readViewportHeight = () => conversation.evaluate((element) => element.clientHeight);
  const previousHeight = await readViewportHeight();
  await page.setViewportSize({ width: 320, height: 500 });
  await expect.poll(readViewportHeight).toBeLessThan(previousHeight);
  const jump = button("Jump to latest message");
  const latestActions = more("reply-two");
  const viewportHeight = await readViewportHeight();
  await latestActions.focus();
  await expect(jump).toBeVisible();
  assert.equal(await readViewportHeight(), viewportHeight);
  const shelf = await jump.boundingBox();
  const transcript = await conversation.boundingBox();
  assert(shelf && transcript && shelf.y >= transcript.y + transcript.height,
    "Jump to latest should sit outside the transcript and leave reply controls clickable");
  await openMenu("reply-two");
  await page.keyboard.press("Escape");
  await expect(latestActions).toBeFocused();
  await page.screenshot({ path: `${dir}/chat-narrow-jump-to-latest.png` });
  await jump.focus();
  const gap = () => conversation.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await conversation.evaluate((element) => new Promise((resolve) => {
    element.addEventListener("scroll", () => resolve(), { once: true });
    element.scrollTop = element.scrollHeight - element.clientHeight - 64;
  }));
  await expect.poll(gap).toBeGreaterThan(24);
  await conversation.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(jump).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  assert.equal(await readViewportHeight(), viewportHeight);

  await page.setViewportSize({ width: 390, height: 500 });
  await openMenu("reply-two");
  const bounds = await menu.boundingBox();
  const anchor = await more("reply-two").boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 500);
  assert(Math.abs(bounds.x - anchor.x) < 20 && Math.min(Math.abs(bounds.y - anchor.y - anchor.height), Math.abs(bounds.y + bounds.height - anchor.y)) < 24,
    "The menu should stay next to its trigger even when it must open above it");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  assert(bounds.y + bounds.height <= (await composer.boundingBox()).y, "A reply menu must leave the composer usable");
  await composer.click();
  await expect(menu).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 420 });
  await openMenu("reply-two");
  await conversation.evaluate((element) => {
    if (element.scrollHeight - element.clientHeight <= 16) throw new Error("The transcript must be scrollable");
    element.scrollTop += element.scrollTop > 16 ? -16 : 16;
  });
  await expect(menu).toHaveCount(0);
  await expect(more("reply-two")).not.toBeFocused();
  await page.setViewportSize({ width: 390, height: 500 });

  await openMenu("reply-one");
  await item("Delete reply").click();
  await expect(confirmation).toContainText("Delete this reply?");
  await expect(confirmation).toHaveAccessibleDescription("Delete this reply?");
  await expect(button("Cancel")).toBeFocused();
  await openMenu("prompt-two");
  await item("Delete message").click();
  await expect(confirmation).toHaveCount(1);
  await expect(row("prompt-two").getByRole("group", { name: "Confirm message deletion" })).toContainText("Delete this message and its reply?");
  await page.keyboard.press("Escape");
  await expect(more("prompt-two")).toBeFocused();
  await expect(confirmation).toHaveCount(0);

  await openMenu("reply-two");
  await item("Delete reply").click();
  await page.setViewportSize({ width: 1440, height: 880 });
  await button("Text thread: Another chat").click();
  await button("Text thread: Message actions").click();
  await expect(confirmation).toHaveCount(0);
  await expect(row("reply-two")).toContainText("Here is a second idea.");

  const historicalFork = row("reply-two").getByRole("button", { name: "Fork chat here", exact: true });
  await historicalFork.evaluate((element) => { element.dataset.beforeGeneration = "true"; });
  await more("prompt-two").evaluate((element) => { element.dataset.beforeGeneration = "true"; });
  await composer.fill("One more idea, please.");
  await button("Send message").click();
  const stop = button("Stop generation");
  await expect(stop).toBeEnabled();
  await expect(historicalFork).toBeDisabled();
  await expect(historicalFork).toHaveAttribute("data-before-generation", "true");
  await expect(more("prompt-two")).toHaveAttribute("data-before-generation", "true");
  await openMenu("prompt-two");
  await expect(item("Delete message")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await stop.click();
  await expect(historicalFork).toBeEnabled();
  await expect(historicalFork).toHaveAttribute("data-before-generation", "true");
  await openMenu("prompt-two");
  await expect(item("Delete message")).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log("Reply actions reveal on hover and focus, stay visible on touch, and dismiss during transcript scrolling.");
} finally {
  await close();
}
