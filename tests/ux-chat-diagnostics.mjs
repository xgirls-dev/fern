import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const prompt = "Private budget draft";
const model = { id: "local", name: "Custom model from a private folder", installed: true, format: "gguf" };
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], runtimeAvailable: true, ggufAvailable: true, devices: ["AUTO", "GPU", "CPU"],
    supportsJobPolling: true, job: { id: null, status: "idle" } },
});

const installClipboard = (version) =>
  page.evaluate((version) => {
    window.studio.appVersion = version;
    window.studio.architecture = "x64";
    window.studio.copyText = async (text) => {
      if (window.rejectDiagnosticCopy) throw new Error("Clipboard is unavailable");
      window.copiedDiagnostics = text;
    };
  }, version);

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await installClipboard("0.1.48");
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("article", { name: "Response in progress" })).toBeVisible();
  const { id: jobId, threadId } = state.textStatus.job;
  state.textStatus.job = {
    ...state.textStatus.job, status: "failed", partialText: "Private partial text",
    partialReasoning: "Private reasoning", error: "Could not load C:\\Users\\private\\budget.gguf",
    errorCode: "intel-vulkan-driver", failureDiagnostics: {
      stage: "loading-model", runtime: "gguf", backend: "vulkan", requestedDevice: "AUTO", device: "GPU",
      modelName: model.name, error: "Private backend log", appVersion: "0.0.1", platform: "linux",
    },
  };
  const failed = page.getByRole("article", { name: "Model response" }).filter({ hasText: "Private partial text" });
  const expected = [
    "Fern chat diagnostics",
    "Fern version at failure: 0.1.48",
    "System: Windows x64",
    "Runtime: GGUF (llama.cpp) / Vulkan",
    "Requested device: Auto",
    "Selected device: GPU",
    "Stage: Loading the model",
    "Failure code: intel-vulkan-driver",
  ].join("\n");
  await expect(failed).toContainText("Could not load");
  await chooseMessageAction(failed, "Copy reply diagnostics");
  await expect(failed.getByRole("button", { name: "More message actions", exact: true })).toBeFocused();
  await expect(page.getByText("Reply diagnostics copied.", { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.copiedDiagnostics), expected);

  await expect.poll(async () => (await savedTextWorkspace(page))?.threads
    .find((thread) => thread.id === threadId)?.messages.find((message) => message.jobId === jobId)?.failureDiagnostics)
    .toEqual({ stage: "loading-model", runtime: "gguf", backend: "vulkan", requestedDevice: "AUTO", device: "GPU",
      appVersion: "0.1.48", platform: "win32", architecture: "x64" });
  state.textStatus.job = { id: null, status: "idle" };
  await page.reload();
  await installClipboard("0.1.49");
  await page.getByRole("button", { name: `Text thread: ${prompt}`, exact: true }).click();
  await expect(failed).toBeVisible();
  await chooseMessageAction(failed, "Copy reply diagnostics");
  await expect.poll(() => page.evaluate(() => window.copiedDiagnostics)).toBe(expected);

  await page.evaluate(() => { window.rejectDiagnosticCopy = true; });
  await chooseMessageAction(failed, "Copy reply diagnostics");
  await expect(page.getByText("Couldn’t copy reply diagnostics.", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Reply diagnostics copy only allowlisted support fields and retain the failure build across relaunches.");
} finally {
  await close();
}
