import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536 };
const otherModel = { contextSize: 12288, maxNewTokens: 1024 };
const chat = { id: "text-thread-defaults", title: "Model defaults", modelId: model.id, contextSize: 24789, maxNewTokens: 15100, messages: [] };
const { page, close, errors } = await fixture({
  firstRun: true,
  textStatus: { models: [model], defaultModelId: model.id, ggufAvailable: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: chat.id, threads: [chat], modelDefaults: { gemma: { contextSize: 16384 }, other: otherModel } },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const context = page.getByRole("spinbutton", { name: /^Context length/ });
const output = page.getByRole("spinbutton", { name: /^Maximum output/ });
const settings = async () => {
  if (!(await context.isVisible())) await button("Chat settings").click();
};
const blockSaves = () => page.evaluate(() => { window.failChatHeaderWrite = true; });
const diskDefaults = async () => (await savedTextWorkspace(page))?.modelDefaults;
const exitCheckpoint = () => page.evaluate(() => localStorage.getItem("fern-text-model-defaults-checkpoint:v1"));

try {
  await expect.poll(async () => (await diskDefaults())?.gemma?.contextSize).toBe(16384);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const newerWrite = typeof window.newerContext === "number" && value.modelDefaults?.gemma?.contextSize === window.newerContext;
      if (window.failChatHeaderWrite && this.transaction.db.name === "fern-text-workspace" && key === "header" && !newerWrite) {
        throw new DOMException("Fixture interrupted the workspace header write", "AbortError");
      }
      return put.apply(this, arguments);
    };
  });
  await page.reload();
  await settings();
  await expect(context).toHaveValue("24789");
  await blockSaves();
  await button("Save model defaults").click();
  await expect(button("Retry saving chats")).toBeVisible();
  assert.equal((await diskDefaults()).gemma.contextSize, 16384);
  await page.reload();
  await expect.poll(async () => (await diskDefaults())?.gemma?.contextSize).toBe(24789);
  await expect.poll(exitCheckpoint).toBeNull();
  assert.equal((await diskDefaults()).other.contextSize, otherModel.contextSize);

  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New text thread", exact: true })).toBeVisible();
  await settings();
  await expect(context).toHaveValue("24789");
  await expect(output).toHaveValue("15100");
  await expect.poll(async () => (await savedTextWorkspace(page))?.activeId).not.toBe(chat.id);
  await blockSaves();
  await button("Clear defaults").click();
  await expect(button("Retry saving chats")).toBeVisible();
  assert.equal((await diskDefaults()).gemma.contextSize, 24789);
  await page.reload();
  await expect.poll(async () => (await diskDefaults())?.gemma).toBeUndefined();
  await expect.poll(exitCheckpoint).toBeNull();
  assert.equal((await diskDefaults()).other.contextSize, otherModel.contextSize);
  await settings();
  await expect(button("Clear defaults")).toHaveCount(0);
  await expect(context).toHaveValue("24789");
  await blockSaves();
  await button("Save model defaults").click();
  await expect(button("Retry saving chats")).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    window.newerContext = 32768;
  });
  await expect.poll(exitCheckpoint).not.toBeNull();
  const workspace = await savedTextWorkspace(page);
  await savedTextWorkspace(page, { ...workspace, modelDefaults: { ...workspace.modelDefaults, gemma: { contextSize: 32768 } } });
  await page.reload();
  await settings();
  assert.equal((await diskDefaults()).gemma.contextSize, 32768);
  await expect.poll(exitCheckpoint).toBeNull();
  assert.deepEqual(errors, []);
  console.log("Interrupted model-default saves and clears survive reload without replacing newer defaults, other models, or existing chat settings.");
} finally {
  await close();
}
