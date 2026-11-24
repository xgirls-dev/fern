import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const river = { id: "local-river", name: "River 3B", format: "gguf", ownership: "managed", installed: true };
const oak = { id: "oak", name: "Oak OpenVINO", installed: true };
const reed = { id: "reed", name: "Reed GGUF", format: "gguf", installed: false, error: "Model file moved." };
const draft = "Keep the original question.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: { models: [river, oak, reed], recommendedModels: [
    { id: "river-recommended", name: river.name, format: river.format, installed: true, registeredModelId: river.id, bytes: 2e9 },
  ], ggufAvailable: true, runtimeAvailable: false, runtimeError: "The OpenVINO packages are missing.",
  residentModel: null, job: { status: "idle", id: null } },
  legacyTextWorkspace: {
    activeId: "text-thread-runtime",
    threads: [{ id: "text-thread-runtime", title: "Runtime check", modelId: river.id, draft, messages: [] }],
  },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const choice = (name) => page.getByRole("menuitemradio", { name, exact: true });
const runtime = page.getByRole("region", { name: "Chat runtime" });
const library = page.getByRole("region", { name: "Text models" });
const card = library.getByRole("article").filter({ has: page.getByRole("heading", { name: river.name, exact: true }) });
const composer = page.getByRole("textbox", { name: "Message", exact: true });

try {
  await button("Text model: River 3B").click();
  await expect(choice(river.name)).toHaveAccessibleDescription("Ready to load");
  await expect(choice(river.name)).toBeEnabled();
  await expect(choice(oak.name)).toHaveAccessibleDescription("Runtime unavailable");
  await expect(choice(oak.name)).toBeDisabled();
  await expect(choice(reed.name)).toHaveAccessibleDescription("Files unavailable");
  await expect(choice(reed.name)).toBeDisabled();
  await page.keyboard.press("Escape");

  await button("Preferences").click();
  await expect(runtime.getByText("Ready to load", { exact: true })).toBeVisible();
  state.textStatus.job = { status: "running", id: "busy-elsewhere", threadId: "text-thread-elsewhere", modelId: river.id };
  await expect(runtime.getByRole("status")).toHaveText("In use");
  state.textStatus.job = { status: "idle", id: null };
  state.textStatus.residentModel = { modelId: river.id, backend: "openvino", device: "CPU" };
  await expect(runtime.getByText("Loaded", { exact: true })).toBeVisible();
  await expect(runtime.getByText("CPU · OpenVINO", { exact: true })).toBeVisible();
  await button("Manage text models").click();
  await expect(card.getByRole("status")).toHaveText("Loaded");
  await expect(library.getByText("Runtime unavailable · The OpenVINO packages are missing.", { exact: true })).toBeVisible();
  await expect(library.getByText("Files unavailable · Model file moved.", { exact: true })).toBeVisible();
  await button("Return to draft").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
  await button("Text model: River 3B").click();
  await expect(choice(river.name)).toHaveAccessibleDescription("Loaded");
  await page.keyboard.press("Escape");

  state.textStatus.residentModel = null;
  await button("Text model: River 3B").click();
  await expect(choice(river.name)).toHaveAccessibleDescription("Ready to load");
  await page.keyboard.press("Escape");
  state.textStatus.ggufAvailable = false;
  state.textStatus.ggufUnavailableReason = "The GGUF runtime is unsupported on this device.";
  await button("Preferences").click();
  await expect(runtime.getByText("Runtime unavailable", { exact: true })).toBeVisible();
  await expect(runtime.getByText(state.textStatus.ggufUnavailableReason, { exact: true })).toBeVisible();
  await button("Manage text models").click();
  await expect(card.getByRole("status")).toHaveText("Runtime unavailable");
  await button("Return to draft").click();
  await expect(button("Send message")).toBeDisabled();
  await expect(composer).toHaveValue(draft);
  assert.deepEqual(errors, []);
  console.log("Chat, Models, and Preferences agree on ready, loaded, invalid files, and unavailable runtimes.");
} finally {
  await close();
}
