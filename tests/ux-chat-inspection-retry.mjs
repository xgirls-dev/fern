import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseSelectOption } from "./select-option.mjs";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const image = { name: "original-poster.png", prompt: "A red circle", width: 512, height: 512, modelLabel: "Klein 4B" };
const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", supportsVision: true, supportsTools: true };
const { page, state, errors, close } = await fixture({ builtRenderer: process.env.FERN_INSPECTION_BUILT === "1", textStatus: {
  models: [model], imageToolModels: [{ id: "4b", label: "Klein 4B" }],
  runtimeAvailable: true, ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
} });
let admitInspection;
let releaseReceipt;
let pollingOffline = false;
try {
  await page.route("**/api/text/job", (route) => pollingOffline
    ? route.abort()
    : route.fulfill({ json: state.textStatus.job }));
  await page.route("**/outputs/original-poster.png*", (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#efdfc0"/><circle cx="256" cy="256" r="140" fill="#b83e2c"/></svg>',
  }));
  const inspections = [];
  await page.route("**/api/text/inspect-image", async (route) => {
    const payload = route.request().postDataJSON();
    inspections.push(payload);
    await new Promise((resolve) => { admitInspection = resolve; });
    state.textStatus.job = { id: payload.requestId, threadId: payload.threadId, modelId: model.id, status: "running", inspection: true, image, phase: "Checking image…" };
    const accepted = { ...state.textStatus };
    await new Promise((resolve) => { releaseReceipt = resolve; });
    await route.fulfill({ status: 202, json: { job: accepted } });
  });
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  await page.getByRole("spinbutton", { name: /^Context length/ }).fill("12288");
  await page.getByText("Advanced model loading", { exact: true }).click();
  await chooseSelectOption(page.getByLabel("Flash Attention", { exact: true }), "On");
  await page.getByRole("button", { name: "Close chat settings", exact: true }).click();
  const prompt = "Make a red poster";
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(state.textRequests.length, 1);
  const streaming = page.getByRole("article", { name: "Response in progress" });
  const composerStatus = page.locator(".text-composer-hint").getByRole("status");
  const imageCaption = page.locator(".text-generated-artifact figcaption");
  state.textStatus.job = { ...state.textStatus.job, image, status: "running", phase: "Generating image · Rendering the next image" };
  await expect(streaming.getByRole("button", { name: /^Review image/ })).toBeVisible();
  await expect(streaming.getByText("Creating an image…", { exact: true })).toBeVisible();
  await expect(composerStatus).toHaveText("Creating an image…");
  await expect(imageCaption).not.toContainText("Checking image…");
  state.textStatus.job = { ...state.textStatus.job, phase: "Checking the generated image…" };
  await page.getByText(/Checking image…/).first().waitFor();
  const phaseAnnouncement = page.getByRole("status").filter({ hasText: "Checking the image…" });
  await phaseAnnouncement.waitFor();
  assert.equal(await streaming.getByText(/^Checking (the )?image…$/).count(), 1);
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialText: "The check has started." };
  await streaming.getByText("The check has started.", { exact: true }).waitFor();
  await phaseAnnouncement.waitFor();
  assert.equal(await streaming.locator(".text-stream-cursor").count(), 0);
  assert.equal(await page.locator(".text-message--streaming").getAttribute("aria-live"), "off");
  state.textStatus.job = { ...state.textStatus.job, status: "failed", error: "Vision worker disconnected." };
  const retry = page.getByRole("button", { name: "Retry image check", exact: true });
  await retry.waitFor();
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failChatSave && this.transaction.db.name === "fern-text-workspace") {
        throw new DOMException("Fixture write failure", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await page.reload();
  await page.getByRole("button", { name: `Text thread: ${prompt}`, exact: true }).click();
  await retry.waitFor();
  await retry.evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector(".text-generated-artifact figcaption")?.textContent.includes("Checking image…"));
  await phaseAnnouncement.waitFor();
  await expect(imageCaption).not.toContainText("Image check incomplete");
  await expect.poll(() => typeof admitInspection).toBe("function");
  assert.equal(inspections.length, 1);
  assert.equal(await page.locator(".text-generated-artifact").evaluate((figure) => figure.closest("article") === document.activeElement), true);
  assert.equal(inspections[0].image, image.name);
  assert.equal(inspections[0].threadId, state.textRequests[0].threadId);
  assert.equal(inspections[0].contextSize, 12_288);
  assert.deepEqual(inspections[0].loadOptions, { flashAttention: "on" });
  assert.equal(await page.locator(".text-generated-artifact").count(), 1);
  const savedThread = async () => (await savedTextWorkspace(page))?.threads.find((thread) => thread.id === inspections[0].threadId);
  await expect.poll(async () => (await savedThread())?.pendingJobId).toBe(inspections[0].requestId);
  admitInspection();
  await expect.poll(() => typeof releaseReceipt).toBe("function");
  pollingOffline = true;
  await expect(composerStatus).toHaveText("Reconnecting to the text runtime…");
  await expect(imageCaption).toContainText("Reconnecting to check the image…");
  await expect(imageCaption).not.toContainText("Checking image…");
  await expect(imageCaption.locator(".ui-progress-label .spinner")).toHaveCSS("animation-name", "none");
  pollingOffline = false;
  await expect(composerStatus).toHaveText("Checking the image…");
  await expect(imageCaption).toContainText("Checking image…");
  await page.evaluate(() => { window.failChatSave = true; });
  state.textStatus.job = {
    ...state.textStatus.job, status: "complete", partialText: "I see a red circle.",
    result: { modelName: model.name, visionChecked: true, inputTokens: 20, outputTokens: 8, generationSeconds: 1, tokensPerSecond: 8 },
  };
  await page.getByText("I see a red circle.", { exact: true }).waitFor();
  await page.getByText(/Image checked/).waitFor();
  await page.getByRole("status", { name: "Reply status" }).filter({ hasText: "Image check complete." }).waitFor();
  await phaseAnnouncement.waitFor({ state: "hidden" });
  const receipt = page.waitForResponse((response) => response.url().endsWith("/api/text/inspect-image"));
  releaseReceipt();
  await (await receipt).finished();
  assert.equal(state.textRequests.length, 1);
  assert.equal(await page.locator(".text-generated-artifact").count(), 1);
  await page.getByRole("button", { name: "Retry saving chats", exact: true }).waitFor();
  state.textStatus.job = { id: null, status: "idle" };
  await page.reload();
  await expect(page.getByText("I see a red circle.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Image checked/)).toBeVisible();
  await expect(page.locator(".text-generated-artifact")).toHaveCount(1);
  const saved = await savedThread();
  assert.equal(saved.pendingJobId, null);
  assert.equal(saved.messages.at(-1).jobId, state.textRequests[0].requestId);
  assert.equal(saved.messages.at(-1).inspectionJobId, undefined);
  assert.equal(saved.messages.at(-1).metrics.visionChecked, true);
  assert.deepEqual(errors, []);
  console.log("Image previews keep generation status, and image checks report admission and reconnect before settling.");
} finally {
  admitInspection?.();
  releaseReceipt?.();
  await close();
}
