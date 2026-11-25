import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const managed = { id: "river-local", name: "River 3B", format: "gguf", ownership: "managed", installed: true };
const linked = { id: "spruce", name: "Spruce 4B", format: "gguf", ownership: "linked", installed: true };
const recommendation = { id: "river-recommended", name: managed.name, format: "gguf", bytes: 2e9, installed: true };
const draft = "Continue from the answer I saved.";
const { page, state, errors, close } = await fixture({
  viewport: { width: 800, height: 640 },
  textStatus: { models: [managed, linked], recommendedModels: [recommendation],
    ggufAvailable: true, runtimeAvailable: false, supportsModelUnload: true,
    residentModel: { modelId: managed.id, backend: "vulkan", device: "GPU" }, job: { status: "idle", id: null } },
  legacyTextWorkspace: {
    activeId: "text-thread-ownership",
    threads: [{
      id: "text-thread-ownership", title: "Reading group", modelId: managed.id, draft,
      messages: [
        { id: "prompt", role: "user", content: "Summarize the next chapter.", createdAt: 1 },
        { id: "reply", role: "assistant", content: "Here is the saved reply.", createdAt: 2 },
      ],
    }],
  },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const library = page.getByRole("region", { name: "Text models", exact: true });
const confirmation = library.getByRole("group", { name: "Confirm removal" });
const operations = [];

try {
  await page.route("**/api/text/models/unload", (route) => {
    assert.deepEqual(route.request().postDataJSON(), { modelId: managed.id });
    state.textStatus.residentModel = null;
    return route.fulfill({ json: { residentModel: null } });
  });
  await page.route("**/api/text/models/remove", (route) => {
    const request = route.request().postDataJSON();
    operations.push(request);
    state.textStatus.models = state.textStatus.models.filter((model) => model.id !== request.modelId);
    if (request.action === "remove-download") {
      state.textStatus.recommendedModels = [{ ...recommendation, installed: false }];
    }
    return route.fulfill({ json: {
      models: state.textStatus.models,
      recommendedModels: state.textStatus.recommendedModels,
    } });
  });
  await button("Models").click();
  await page.getByRole("group", { name: "Model categories" }).getByRole("button", { name: "Text", exact: true }).click();
  await expect(library.getByText("Downloaded by Fern", { exact: false })).toBeVisible();
  await expect(library.getByText("Linked files", { exact: false })).toBeVisible();
  await expect.poll(() => library.locator(".models-installed-row").evaluateAll((rows) =>
    rows.every((row) => row.scrollWidth <= row.clientWidth))).toBe(true);
  const remove = button("Remove download for River 3B");
  const unload = button("Unload River 3B");
  await expect(unload).toBeEnabled();
  await expect(button("Unload Spruce 4B")).toHaveCount(0);
  await unload.focus();
  await unload.press("Enter");
  await expect(unload).toHaveCount(0);
  await expect(library.getByRole("heading", { name: "Text models", exact: true })).toBeFocused();
  await expect(remove).toBeEnabled();
  await expect(button("Unlink Spruce 4B")).toBeEnabled();
  await remove.click();
  await expect(confirmation).toHaveAccessibleDescription("Delete this download from disk? Your chats and drafts stay.");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(remove).toBeFocused();
  assert.deepEqual(operations, []);

  await remove.click();
  await confirmation.getByRole("button", { name: "Remove download", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(library.getByRole("heading", { name: "Text models", exact: true })).toBeFocused();
  await expect(library.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  await button("Unlink Spruce 4B").click();
  await expect(confirmation).toHaveAccessibleDescription("Unlink this model? Its files stay on disk.");
  await confirmation.getByRole("button", { name: "Unlink model", exact: true }).click();
  await expect(button("Unlink Spruce 4B")).toHaveCount(0);
  assert.deepEqual(operations, [
    { modelId: managed.id, action: "remove-download" },
    { modelId: linked.id, action: "unlink" },
  ]);

  await button("Expand sidebar").click();
  await button("Text thread: Reading group").click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(draft);
  await expect(page.getByText("Here is the saved reply.", { exact: true })).toBeVisible();
  await expect(page.locator(".text-model-readiness")).toContainText("This chat’s model is unavailable.");
  await expect(button("Browse models")).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log("Managed downloads and linked models have distinct confirmations. Removal keeps saved replies and drafts.");
} finally {
  await close();
}
