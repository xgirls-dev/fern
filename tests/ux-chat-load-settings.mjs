import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseSelectOption } from "./select-option.mjs";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "local-gemma", name: "Gemma", format: "gguf", installed: true, maxContextSize: 65536 };
const resident = { modelId: model.id, backend: "openvino", device: "GPU", gguf: { contextSize: 8192, loadOptions: {} } };
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, residentModel: resident,
    job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: "text-thread-load-settings", threads: [
    { id: "text-thread-load-settings", title: "Model settings", modelId: model.id, messages: [] },
  ] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const inspector = page.getByRole("complementary", { name: "Chat settings panel" });
const reloadNotice = inspector.getByText("Reloads on the next reply.", { exact: true });
const context = inspector.getByRole("spinbutton", { name: /^Context length/ });
let completed = false;
let catalogReadsAfterCompletion = 0;

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.route("**/api/text/status", (route) => {
    if (completed) catalogReadsAfterCompletion++;
    return route.fulfill({ json: state.textStatus });
  });
  await button("Chat settings").click();
  await expect(inspector.getByText("System prompt, maximum output, and sampling apply to the next reply.", { exact: true })).toBeVisible();
  await inspector.getByLabel("System prompt", { exact: true }).fill("Keep the answer concise.");
  await inspector.getByLabel("Temperature value", { exact: true }).fill("0.35");
  await expect(reloadNotice).toHaveCount(0);

  await context.fill("4096");
  await expect(inspector.getByRole("status")).toContainText("Context length changed.");
  await context.fill("8192");
  await expect(reloadNotice).toHaveCount(0);
  await inspector.getByText("Advanced model loading", { exact: true }).click();
  await chooseSelectOption(inspector.getByLabel("Flash Attention", { exact: true }), "On");
  await expect(inspector.getByRole("status")).toContainText("Loading options changed.");
  await context.fill("12288");
  await expect(inspector.getByRole("status")).toContainText("Context length and loading options changed.");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Describe the change.");
  await button("Send message").click();
  await expect(page.getByRole("article", { name: "Response in progress" })).toBeVisible();
  await expect(context).toBeDisabled();
  const request = state.textRequests[0];
  assert.equal(request.contextSize, 12_288);
  assert.deepEqual(request.loadOptions, { flashAttention: "on" });
  assert.equal(request.systemPrompt, "Keep the answer concise.");
  assert.equal(request.temperature, 0.35);

  const loaded = { ...resident, gguf: { contextSize: 12_288, loadOptions: { flashAttention: "on" } } };
  completed = true;
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The settings are applied.",
    finishedAt: Date.now() / 1000, residentModel: loaded };
  await expect(page.getByText("The settings are applied.", { exact: true })).toBeVisible();
  await expect(context).toBeEnabled();
  await expect(reloadNotice).toHaveCount(0);
  assert.equal(catalogReadsAfterCompletion, 0, "The job status should update loading feedback without a catalog request.");
  state.textStatus.residentModel = loaded;
  await button("Reset model loading").click();
  await expect(inspector.getByRole("status")).toContainText("Loading options changed.");
  assert.deepEqual(errors, []);
  console.log("Reply settings, planned reloads, reverting edits, and warm settings after completion agree.");
} finally {
  await close();
}
