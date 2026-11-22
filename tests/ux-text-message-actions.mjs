import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const id = "text-thread-message-actions";
const otherId = "text-thread-message-actions-other";
const reply = (id, content, createdAt) => ({ id, role: "assistant", content, createdAt, status: "complete", modelName: "Local model",
  metrics: { inputTokens: 25, outputTokens: 12, generationSeconds: 1, tokensPerSecond: 12, backend: "Vulkan" } });
const { page, close, errors } = await fixture({
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
  await expect(row("reply-one").getByRole("button", { name: "Copy message" })).toBeVisible();
  await expect(row("prompt-one").getByRole("button", { name: "Edit message" })).toBeVisible();
  await expect(row("reply-two").getByRole("button", { name: "Regenerate response" })).toBeVisible();
  await expect(button("Delete reply")).toHaveCount(0);
  await expect(menu).toHaveCount(0);

  await more("reply-one").focus();
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

  await openMenu("reply-one");
  await item("Delete reply").click();
  await expect(confirmation).toContainText("Delete this reply?");
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
  assert.deepEqual(errors, []);
  console.log("Compact reply actions, anchored menus, keyboard focus, and one scoped deletion confirmation passed.");
} finally {
  await close();
}
