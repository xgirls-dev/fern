import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const notebook = "text-thread-ime-notebook";
const { page, state, errors, close } = await fixture({
  firstRun: true, viewport: { width: 864, height: 680 },
  legacyTextWorkspace: { activeId: notebook, threads: [
    { id: notebook, title: "Notebook", draft: "日本語", modelId: "local", messages: [
      { id: "previous-answer", role: "assistant", content: "日本語の見出し\n\n日本語の例", createdAt: 10 },
    ] },
    { id: "text-thread-ime-archive", title: "Archive", draft: "Archive draft", modelId: "local", messages: [] },
  ] },
  textStatus: { models: [{ name: "Local model", id: "local", format: "gguf", installed: true }], ggufAvailable: true, job: { status: "idle", id: null } },
});

function pressImeKey(field, key, modifiers = {}) {
  return field.evaluate((element, options) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, keyCode: 229, ...options });
    if (event.keyCode !== 229 || event.isComposing) throw new Error("Expected the legacy composition signal alone");
    return element.dispatchEvent(event);
  }, { key, ...modifiers });
}

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const find = page.getByRole("searchbox", { name: "Search this chat" });
const status = page.getByRole("search", { name: "Find in chat" }).getByRole("status");

try {
  await expect(composer).toHaveValue("日本語");
  await composer.focus();
  assert(await pressImeKey(composer, "Enter"));
  assert.equal(state.textRequests.length, 0);
  assert(await pressImeKey(composer, "f", { ctrlKey: true }));
  await expect(find).toHaveCount(0);
  await button("Find in chat").click();
  await find.fill("日本語");
  await expect(status).toHaveText("1 of 2");
  assert(await pressImeKey(find, "Enter", { shiftKey: true }));
  assert(await pressImeKey(find, "Escape"));
  await expect(status).toHaveText("1 of 2");
  await find.press("Enter");
  await expect(status).toHaveText("2 of 2");
  await find.press("Shift+Enter");
  await expect(status).toHaveText("1 of 2");
  const next = button("Next match");
  await next.focus();
  await next.press("Enter");
  await expect(status).toHaveText("2 of 2");
  await find.press("Escape");

  await button("Open text thread").click();
  const picker = page.getByRole("dialog", { name: "Search chats", exact: true });
  const query = picker.getByRole("searchbox");
  await query.fill("Archive");
  await expect(picker.getByRole("button", { name: /^Archive/ })).toBeVisible();
  assert(await pressImeKey(query, "ArrowDown"));
  assert(await pressImeKey(query, "Escape"));
  assert(await pressImeKey(query, "Enter"));
  await expect(query).toBeFocused();
  await query.press("Enter");
  await expect(composer).toHaveValue("Archive draft");

  const commandShortcut = await page.evaluate(() => navigator.platform.startsWith("Mac")) ? "Meta+k" : "Control+k";
  await page.keyboard.press(commandShortcut);
  const commands = page.getByRole("combobox", { name: "Search commands or threads" });
  await commands.fill("Notebook");
  await expect(page.getByRole("option", { selected: true })).toContainText("Notebook");
  assert(await pressImeKey(commands, "Enter"));
  assert(await pressImeKey(commands, "Escape"));
  await expect(commands).toBeFocused();
  await commands.press("Enter");
  await expect(composer).toHaveValue("日本語");

  await composer.press("Enter");
  await expect.poll(() => state.textRequests.length).toBe(1);
  const stop = button("Stop generation");
  await expect(stop).toHaveCSS("background-color", "rgb(32, 32, 32)");
  await expect(stop).toHaveCSS("color", "rgb(255, 255, 255)");
  await stop.hover();
  await expect(stop).toHaveCSS("background-color", "rgb(56, 56, 56)");
  await expect(stop).toHaveCSS("color", "rgb(255, 255, 255)");
  await button("Toggle theme").click();
  await expect(stop).toHaveCSS("background-color", "rgb(236, 236, 236)");
  await expect(stop).toHaveCSS("color", "rgb(33, 33, 33)");
  await stop.hover();
  await expect(stop).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(stop).toHaveCSS("color", "rgb(33, 33, 33)");
  await composer.focus();
  assert(await pressImeKey(composer, "Escape"));
  await expect(stop).toBeVisible();
  await composer.press("Escape");
  await expect.poll(() => state.textStatus.job.status).toBe("stopped");
  await expect(button("Send message")).toBeVisible();

  await composer.fill("Tell me more.");
  await composer.press("Enter");
  await expect.poll(() => state.textRequests.length).toBe(2);
  state.textStatus.job = { ...state.textStatus.job, partialText: "This partial reply should stay visible." };
  const liveReply = page.locator(".text-message--streaming");
  await expect(liveReply).toContainText("This partial reply should stay visible.");
  await composer.fill("Keep this draft.");
  await composer.press("Shift+Tab");
  const goToReply = button("Go to latest reply");
  await expect(goToReply).toBeFocused();
  await goToReply.press("Enter");
  await expect(liveReply).toBeFocused();
  assert(await pressImeKey(liveReply, "Escape"));
  await liveReply.press("Shift+Escape");
  await expect(button("Stop generation")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => state.textStatus.job.status).toBe("stopped");
  const stoppedReply = page.getByRole("article", { name: "Model response", exact: true }).last();
  await expect(stoppedReply).toContainText("This partial reply should stay visible.");
  await expect(stoppedReply).toBeFocused();
  await expect(composer).toHaveValue("Keep this draft.");

  assert.deepEqual(errors, []);
  console.log("IME candidate keys preserve chat drafts, match position, search dialogs, and running replies.");
} finally {
  await close();
}
