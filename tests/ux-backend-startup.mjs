import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const failure = "Fern's Python backend exited during startup.";
const draft = "Keep these notes while the service starts.";
const model = { id: "local", name: "Local model", installed: true, format: "gguf" };
const { page, state, errors, close } = await fixture({
  firstRun: true, backendStartupFailure: failure,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const retry = page.getByRole("button", { name: "Retry starting Fern", exact: true });
const send = page.getByRole("button", { name: "Send message", exact: true });
const startupAlert = page.getByRole("alert").filter({ hasText: "Fern couldn’t start its local service." });
let finishRetry;
let retries = 0;
const startup = new Promise((resolve) => { finishRetry = resolve; });

try {
  await page.route("**/fixture/backend-retry", async (route) => {
    retries++;
    await startup;
    await route.fulfill({ json: { ok: true } });
  });
  await expect(startupAlert).toContainText(failure);
  await composer.fill(draft);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads[0]?.draft).toBe(draft);
  await page.reload();
  await expect(startupAlert).toBeVisible();
  await expect(composer).toHaveValue(draft);
  await retry.focus();
  await retry.press("Enter");
  await expect(startupAlert).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.getByText("Checking local models…", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  finishRetry();
  await expect(send).toBeEnabled();
  await send.click();
  assert.equal(retries, 1);
  assert.equal(state.textRequests[0].messages.at(-1).content, draft);
  assert.deepEqual(errors, []);
  console.log("Retry recovers the local chat service and sends the draft saved before reload.");
} finally {
  finishRetry();
  await close();
}
