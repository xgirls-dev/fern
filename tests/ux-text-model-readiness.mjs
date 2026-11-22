import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const draftId = "text-thread-first-draft";
const oldId = "text-thread-model-removed";
const automaticId = "text-thread-default-choice";
const river = { id: "river", name: "River 3B", format: "gguf", bytes: 2e9, installed: false };
const spruce = { id: "spruce", name: "Spruce 4B", format: "gguf", installed: true };
const retired = { id: "old", name: "Alpine 7B", format: "gguf", installed: false, error: "Model files moved outside Fern." };
const draft = "Help me write a short introduction.";
const { page, state, errors, close } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_READINESS_BUILT === "1",
  textStatus: { models: [], ggufAvailable: true, runtimeAvailable: false, defaultModelId: river.id,
    recommendedModels: [river], job: { status: "idle", id: null } },
  legacyTextWorkspace: { activeId: draftId, threads: [
    { id: draftId, title: "First draft", messages: [] },
    { id: oldId, title: "Existing chat", modelId: retired.id, draft: "Keep this follow-up.", messages: [
      { id: "saved-user", role: "user", content: "An earlier prompt.", createdAt: 1 },
      { id: "saved-assistant", role: "assistant", content: "An earlier reply.", createdAt: 2 },
    ] },
    { id: automaticId, title: "Automatic model", draft: "Pick a usable default.", messages: [] },
  ] },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const message = page.getByRole("textbox", { name: "Message", exact: true });
const setup = page.getByRole("region", { name: "Draft setup" });
const modelReadiness = page.locator(".text-model-readiness");
let delayCatalog = true;
let catalogOffline = true;
let openCatalog;

try {
  await page.route("**/api/text/status", async (route) => {
    if (delayCatalog) await new Promise((resolve) => { openCatalog = resolve; });
    return catalogOffline ? route.fulfill({ status: 503, json: { error: "The local runtime did not respond." } })
      : route.fulfill({ json: state.textStatus });
  });
  await page.route("**/api/text/models/install", (route) => {
    assert.equal(route.request().postDataJSON().modelId, river.id);
    state.textStatus.modelInstall = { id: "download-1", modelId: river.id, status: "downloading", phase: "Downloading model files…", error: null };
    return route.fulfill({ status: 202, json: state.textStatus });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Checking local models…", { exact: true })).toHaveCount(1);
  await expect(button("Browse models")).toHaveCount(0);
  await message.fill(draft);
  await expect(button("Send message")).toBeDisabled();
  await expect.poll(() => typeof openCatalog).toBe("function");
  delayCatalog = false;
  openCatalog();
  await expect(modelReadiness.getByRole("alert")).toContainText("The local runtime did not respond.");
  await expect(button("Browse models")).toHaveCount(0);
  catalogOffline = false;
  await button("Retry checking models").click();
  await expect(button("Browse models")).toBeVisible();
  await button("Browse models").click();
  await expect(setup).toBeVisible();
  await button("Download").click();
  await expect(page.getByRole("progressbar", { name: "Text model installation" })).toBeVisible();
  await button("Return to draft").click();
  await expect(message).toHaveValue(draft);
  await expect(message).toBeFocused();
  await expect(modelReadiness).toContainText("River 3B");
  await expect(modelReadiness).toContainText("Downloading model files…");
  await expect(button("Browse models")).toHaveCount(0);
  await expect(button("Send message")).toBeDisabled();
  await page.reload();
  await expect(message).toHaveValue(draft);
  await expect(button("View model download")).toBeVisible();
  assert.equal(state.textRequests.length, 0);

  state.textStatus.modelInstall = { ...state.textStatus.modelInstall, status: "failed", error: "The download was interrupted." };
  await expect(modelReadiness.getByRole("alert")).toContainText("The download was interrupted.");
  await button("Open model setup").click();
  await button("Download").click();
  await expect(page.getByRole("progressbar", { name: "Text model installation" })).toBeVisible();
  await button("Return to draft").click();
  await button("View model download").focus();
  await expect(button("View model download")).toBeFocused();
  state.textStatus.recommendedModels = [{ ...river, installed: true }];
  state.textStatus.models = [{ ...river, installed: true }, spruce, retired];
  state.textStatus.modelInstall = { ...state.textStatus.modelInstall, status: "complete" };
  await expect(message).toBeFocused();
  await expect(button("Send message")).toBeEnabled();
  await button("Text model: River 3B").click();
  await page.getByRole("menuitem", { name: "Manage models", exact: true }).click();
  const selection = setup.getByRole("combobox", { name: "Chat model" });
  await expect(selection).toHaveValue(river.id);
  await selection.selectOption(spruce.id);
  await button("Use model in draft").click();
  await expect(message).toHaveValue(draft);
  await expect(message).toBeFocused();
  await expect(button("Text model: Spruce 4B")).toBeVisible();
  assert.equal(state.textRequests.length, 0);

  await button("Text thread: Existing chat").click();
  await expect(message).toHaveValue("Keep this follow-up.");
  await expect(page.getByText("An earlier reply.", { exact: true })).toBeVisible();
  await expect(modelReadiness).toContainText("Alpine 7B is unavailable.");
  await expect(modelReadiness).toContainText("Model files moved outside Fern.");
  await button("Choose another model").click();
  await expect(selection).toHaveValue(river.id);
  await button("Use model in draft").click();
  await expect(message).toHaveValue("Keep this follow-up.");
  await expect(button("Text model: River 3B")).toBeVisible();
  await expect(modelReadiness).toHaveCount(0);
  await button("Text thread: First draft").click();
  await expect(message).toHaveValue(draft);
  await expect(button("Text model: Spruce 4B")).toBeVisible();

  const unavailableDefault = { id: "default-openvino", name: "OpenVINO default", installed: true };
  state.textStatus.models = [unavailableDefault, spruce];
  state.textStatus.defaultModelId = unavailableDefault.id;
  await button("Text thread: Automatic model").click();
  await expect(page.getByRole("log").getByText("Pick a usable default.", { exact: true })).toHaveCount(0);
  await expect(message).toHaveValue("Pick a usable default.");
  await expect(button("Text model: Spruce 4B")).toBeVisible();
  await button("Text model: Spruce 4B").click();
  await expect(page.getByRole("menuitemradio", { name: /OpenVINO default/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.map((request) => request.modelId)).toEqual([spruce.id]);
  assert.deepEqual(errors, []);
  console.log("Model checking and failed downloads are recoverable, drafts survive setup, and model choice stays scoped to its chat.");
} finally {
  openCatalog?.();
  await close();
}
