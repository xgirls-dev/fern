import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const image = { name: "original-poster.png", prompt: "A red circle", width: 512, height: 512, modelLabel: "Klein 4B" };
const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", supportsVision: true, supportsTools: true };
const { page, state, errors, close } = await fixture({ textStatus: {
  models: [model], imageToolModels: [{ id: "4b", label: "Klein 4B" }],
  runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" },
} });
try {
  await page.route("**/outputs/original-poster.png*", (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#efdfc0"/><circle cx="256" cy="256" r="140" fill="#b83e2c"/></svg>',
  }));
  const inspections = [];
  await page.route("**/api/text/inspect-image", async (route) => {
    const payload = route.request().postDataJSON();
    inspections.push(payload);
    state.textStatus.job = { id: payload.requestId, threadId: payload.threadId, modelId: model.id, status: "running", inspection: true, image, phase: "Checking image…" };
    await route.fulfill({ status: 202, json: { job: state.textStatus } });
  });
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: /New text thread|Chat/ }).click();
  const prompt = "Make a red poster";
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(state.textRequests.length, 1);
  state.textStatus.job = { ...state.textStatus.job, image, status: "running", phase: "Checking the generated image…" };
  await page.getByText(/Checking image…/).first().waitFor();
  const phaseAnnouncement = page.getByRole("status").filter({ hasText: "Checking the image…" });
  await phaseAnnouncement.waitFor();
  assert.equal(await page.locator(".text-message--streaming").getAttribute("aria-live"), "off");
  state.textStatus.job = { ...state.textStatus.job, status: "failed", error: "Vision worker disconnected." };
  const retry = page.getByRole("button", { name: "Retry image check", exact: true });
  await retry.waitFor();
  await page.reload();
  await page.getByRole("button", { name: `Text thread: ${prompt}`, exact: true }).click();
  await retry.waitFor();
  await retry.evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector(".text-generated-artifact figcaption")?.textContent.includes("Checking image…"));
  assert.equal(inspections.length, 1);
  assert.equal(inspections[0].image, image.name);
  assert.equal(inspections[0].threadId, state.textRequests[0].threadId);
  assert.equal(await page.locator(".text-generated-artifact").count(), 1);
  state.textStatus.job = {
    ...state.textStatus.job, status: "complete", partialText: "I see a red circle.",
    result: { modelName: model.name, visionChecked: true, inputTokens: 20, outputTokens: 8, generationSeconds: 1, tokensPerSecond: 8 },
  };
  await page.getByText("I see a red circle.", { exact: true }).waitFor();
  await page.getByText(/Image checked/).waitFor();
  await phaseAnnouncement.waitFor({ state: "hidden" });
  assert.equal(state.textRequests.length, 1);
  assert.equal(await page.locator(".text-generated-artifact").count(), 1);
  assert.deepEqual(errors, []);
  console.log("Failed inspection can be retried after relaunch without submitting a second render.");
} finally {
  await close();
}
