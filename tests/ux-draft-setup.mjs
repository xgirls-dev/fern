import { chooseSelectOption } from "./select-option.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const platform = process.env.FERN_TEST_PLATFORM || "linux";
const { page, state, errors, dir, close } = await fixture({
  platform,
  imageCount: 0,
  installedModels: [],
  viewport: { width: 1440, height: 920 },
});
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  const klein = { id: platform === "darwin" ? "klein-4b-mlx" : "4b", label: "Klein 4B", bytes: 4e9,
    category: "image", downloaded: 0, installed: false, state: "not-installed",
    minimumFreeBytes: 4e9 + 2 * 1024 ** 3,
    generationDevices: platform === "darwin" ? ["APPLE_GPU"] : ["INTEL_GPU", "NVIDIA_GPU", "CPU"],
    downloadIncludes: ["Text encoder", "VAE"] };
  const gemma = { id: "gemma", name: "Gemma", format: "gguf", bytes: 5e9, minimumFreeBytes: 5_536_870_912,
    projectorBytes: 560e6, supportsTools: true, installed: false };
  state.textStatus.ggufAvailable = true;
  state.textStatus.recommendedModels.push({ id: "vision-only", name: "Vision without image tools", format: "gguf",
    bytes: 2e9, projectorBytes: 256e6, installed: false }, gemma);
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [klein] } }));
  await page.route("**/api/models/install", (route) => {
    assert.equal(route.request().postDataJSON().model, klein.id);
    Object.assign(klein, { downloaded: klein.bytes, installed: true, state: "installed" });
    state.installedModels = [klein];
    state.textStatus.imageToolModels = [klein];
    return route.fulfill({ json: { models: [klein] } });
  });
  await page.route("**/api/text/models/install", (route) => {
    assert.equal(route.request().postDataJSON().modelId, gemma.id);
    gemma.installed = true;
    state.textStatus.models = [{ ...gemma, supportsTools: true, supportsVision: true }];
    return route.fulfill({ json: state.textStatus });
  });
  const draft = "Make a poster with a red circle.";
  await page.locator("#prompt").fill(draft);
  const setup = button("Set up an image model");
  await setup.waitFor();
  assert(await button("Generate image").isDisabled());
  assert.equal(await page.getByText("Ctrl ↵ to generate", { exact: true }).count(), 0);
  await page.screenshot({ path: `${dir}/01-image-draft-${platform}-fixture-light-1440x920.png` });
  await setup.click();
  await button("Return to draft").click();
  assert.equal(await page.locator("#prompt").inputValue(), draft);
  await setup.click();
  await button("Images").click();
  await page.getByRole("heading", { name: "Images", exact: true }).waitFor();
  await button("Return to draft").waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Images", exact: true }).waitFor();
  await button("Return to draft").click();
  assert.equal(await page.locator("#prompt").inputValue(), draft);
  await setup.click();
  await page.reload();
  await button("Return to draft").waitFor();
  await page.getByText("Klein 4B · 4.00 GB download", { exact: true }).waitFor();
  const kleinCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Klein 4B", exact: true }) });
  const install = kleinCard.getByRole("button", { name: "Install", exact: true });
  await expect(kleinCard.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(install).toHaveAccessibleDescription(/Klein 4B\s+Download\s+4\.00 GB\s+Device/);
  await expect(install).toHaveAccessibleDescription(platform === "darwin" ? /Apple GPU/ : /Intel GPU, NVIDIA GPU.*CPU/);
  await expect(install).toHaveAccessibleDescription(/Free space\s+At least 6\.15 GB for a fresh install/);
  await expect(install).toHaveAccessibleDescription(/Includes\s+Text encoder, VAE/);
  await page.screenshot({ path: `${dir}/image-model-setup-${platform}-fixture-light-1440x920.png` });
  await install.click();
  const useModel = button("Use model in draft");
  await expect(useModel).toBeVisible();
  if (platform === "darwin") {
    const setDevice = (device) => page.evaluate((selection) => localStorage.setItem(
      "fern-compute-preference:v1", JSON.stringify({ allowCpu: true, device: selection }),
    ), device);
    await setDevice("CPU");
    await page.reload();
    await expect(page.getByText("Select Available GPU in Preferences to use this image model.")).toBeVisible();
    await expect(useModel).toHaveCount(0);
    await setDevice("GPU");
    await page.reload();
  }
  await useModel.click();
  assert.equal(await page.locator("#prompt").inputValue(), draft);
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  assert.equal(state.payloads.length, 0);
  await button("Generate image").click();
  assert.equal(state.payloads.length, 1);
  assert.equal(state.payloads[0].model, klein.id);

  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill(draft);
  await button("Set up images in chat").click();
  await page.getByText("Gemma · 5.00 GB download", { exact: true }).waitFor();
  await page.getByText("Klein 4B · Installed", { exact: true }).waitFor();
  const gemmaCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Gemma", exact: true }) });
  await expect(gemmaCard.locator("dl")).toContainText(platform === "darwin" ? "Apple GPU" : "Intel GPU");
  await expect(gemmaCard.locator("dl")).toContainText("5.54 GB for a fresh install");
  await expect(gemmaCard.locator("dl")).toContainText("Vision projector · 560 MB");
  if (platform !== "darwin") {
    await expect(page.getByRole("article").filter({ hasText: "Qwen3 4B Instruct 2507" }))
      .toContainText("Fern prepares the tokenizer and detokenizer");
  }
  await gemmaCard.getByRole("button", { name: "Download", exact: true }).click();
  await button("Use models in draft").click();
  assert.equal(await message.inputValue(), draft);
  assert.equal(state.textRequests.length, 0);
  await button("Preferences").click();
  const device = page.getByLabel("Generation device", { exact: true });
  await chooseSelectOption(device, "CPU");
  await page.getByRole("button", { name: /Text thread: New text thread/ }).click();
  await button("Chat settings").click();
  await button("Image").click();
  await button("Open compute settings").click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Generation device");
  await chooseSelectOption(device, "Available GPU");
  await button("Return to chat").click();
  assert.equal(await message.inputValue(), draft);
  await button("Send message").click();
  assert.equal(state.textRequests.length, 1);
  assert.equal(state.textRequests[0].modelId, gemma.id);
  assert.equal(state.textRequests[0].imageModel, klein.id);
  assert.deepEqual(errors, []);
  console.log("Image and chat-image setup preserve drafts and wait for explicit generation.");
} finally {
  await close();
}
