import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536 };
const defaults = { contextSize: 24789, maxNewTokens: 15100, temperature: 0.22, topP: 0.77 };
const previous = { id: "text-thread-previous", title: "Previous chat", contextSize: 4096, messages: [
  { id: "prompt", role: "user", content: "Start here.", createdAt: 1 },
  { id: "reply", role: "assistant", content: "First answer.", createdAt: 2, status: "complete" },
] };
const { page, close, state, errors } = await fixture({
  firstRun: true,
  textStatus: { models: [model], defaultModelId: model.id, ggufAvailable: true, job: { status: "idle", id: null } },
  legacyTextWorkspace: { activeId: previous.id, threads: [previous], modelDefaults: { [model.id]: defaults } },
});
const { promise: catalogReady, resolve: showCatalog } = Promise.withResolvers();
let catalogRequests = 0;
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const context = page.getByRole("spinbutton", { name: /^Context length/ });
const output = page.getByRole("spinbutton", { name: /^Maximum output/ });
const openChat = (id) => page.locator(`button[data-thread-id=${JSON.stringify(id)}]`).click();
async function newChat(previousId) {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  const selected = page.locator(`button[aria-current="page"][data-thread-id]:not([data-thread-id=${JSON.stringify(previousId)}])`);
  await expect(selected).toHaveAccessibleName("Text thread: New text thread");
  await expect(composer).toHaveValue("");
  return selected.getAttribute("data-thread-id");
}
async function savedChat(id) {
  return (await savedTextWorkspace(page))?.threads.find((thread) => thread.id === id);
}

try {
  await expect.poll(async () => (await savedTextWorkspace(page))?.modelDefaults?.gemma?.contextSize).toBe(defaults.contextSize);
  await page.route("**/api/text/status", async (route) => {
    catalogRequests += 1;
    await catalogReady;
    await route.fulfill({ json: state.textStatus });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: previous.title, exact: true })).toBeVisible();
  await expect.poll(() => catalogRequests).toBeGreaterThan(0);
  const firstId = await newChat(previous.id);
  const originalDraft = "Use the saved settings from this model.";
  await composer.fill(originalDraft);
  await expect.poll(async () => (await savedChat(firstId))?.draft).toBe(originalDraft);
  const secondId = await newChat(firstId);
  const editedDraft = "Use a custom output limit.";
  await composer.fill(editedDraft);
  await expect.poll(async () => (await savedChat(secondId))?.draft).toBe(editedDraft);
  await button("Chat settings").click();
  await expect(output).toHaveValue("512");
  await output.click();
  await expect(output).toBeFocused();
  await output.press("ArrowUp");
  await expect(output).toHaveValue("513");
  await expect.poll(async () => (await savedChat(secondId))?.maxNewTokens).toBe(513);
  const beforeReload = catalogRequests;
  await page.reload();
  await expect(composer).toHaveValue(editedDraft);
  await expect.poll(() => catalogRequests).toBeGreaterThan(beforeReload);

  showCatalog();
  await expect(button("Text model: Gemma")).toBeVisible();
  await button("Chat settings").click();
  await expect(context).toHaveValue(String(defaults.contextSize));
  await expect(output).toHaveValue("513");
  await expect(page.getByLabel("Temperature value", { exact: true })).toHaveValue(String(defaults.temperature));
  await expect.poll(async () => (await savedChat(secondId))?.modelId).toBe(model.id);

  await openChat(previous.id);
  await expect(composer).toHaveValue("");
  if (!(await context.isVisible())) await button("Chat settings").click();
  await expect(context).toHaveValue("4096");
  await openChat(firstId);
  if (!(await context.isVisible())) await button("Chat settings").click();
  await expect(composer).toHaveValue(originalDraft);
  await expect(context).toHaveValue(String(defaults.contextSize));
  await expect(output).toHaveValue(String(defaults.maxNewTokens));
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  const [request] = state.textRequests;
  assert.equal(request.threadId, firstId);
  assert.equal(request.modelId, model.id);
  for (const [key, value] of Object.entries(defaults)) assert.equal(request[key], value, key);
  assert.deepEqual(errors, []);
  console.log("Late model defaults survive reload, preserve a per-chat edit, and reach the first request.");
} finally {
  showCatalog();
  await close();
}
