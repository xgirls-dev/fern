import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const { page, state, errors, dir, close } = await fixture({ platform: "linux" });
const speechReason = "Qwen3-TTS setup is unavailable in the Linux beta.";
const turboReason = "Qwen Image Turbo setup is unavailable in the Linux beta. Choose a FLUX.2 Klein model.";
const ggufReason = "Fern's managed GGUF runtime requires Windows or Linux x86-64.";
try {
  state.ttsStatus.models[0].installed = false;
  state.ttsStatus.setupUnavailableReason = speechReason;
  state.textStatus.ggufAvailable = false;
  state.textStatus.ggufUnavailableReason = ggufReason;
  state.textStatus.recommendedModels.push({ id: "gemma", name: "Gemma", format: "gguf", bytes: 5e9, installed: false });
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { id: "qwen21-turbo", label: "Qwen Turbo", bytes: 4e9, downloaded: 0, installed: false, state: "paused", setupUnavailableReason: turboReason },
    { id: "4b", label: "Klein 4B", bytes: 4e9, downloaded: 0, installed: false, state: "not-installed" },
  ] } }));
  await page.reload();
  await page.getByRole("button", { name: "Maximize", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Restore window", exact: true }).waitFor();
  await page.evaluate(() => window.studio.toggleMaximizeWindow());
  await page.getByRole("button", { name: "Maximize", exact: true }).waitFor();
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: /New audio thread|Create speech/ }).click();
  await page.getByText(speechReason, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Set up model", exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.screenshot({ path: `${dir}/02-speech-setup-linux-fixture-light-1440x920.png` });

  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByText(turboReason, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Resume setup" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Install", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await page.getByText(speechReason, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Install", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByText(ggufReason, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Download", exact: true }).count(), 1);
  await page.getByRole("button", { name: /^(Library|Images)$/ }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: /Select.*audit-1\.png/ }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await page.getByRole("heading", { name: /Move 1 image to Trash/ }).waitFor();
  assert.equal(await page.getByText(/Windows Recycle Bin/i).count(), 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(state.images.length, 3);
  await page.getByRole("button", { name: "Delete selected" }).click();
  await page.getByRole("button", { name: "Delete images" }).click();
  await page.getByText("2 images", { exact: true }).waitFor();
  assert.equal(state.images.length, 2);
  assert.deepEqual(errors, []);
  console.log("Linux availability and Trash behavior passed.");
} finally {
  await close();
}
