import { chooseSelectOption } from "./select-option.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", supportsVision: true, supportsTools: true };
const adapter = "C:\\styles\\character.safetensors";
const names = ["a", "b"].map((key) => `chat-image-${key.repeat(32)}.png`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64");
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], imageToolModels: [{ id: "4b-lora", label: "Klein 4B · LoRA" }],
    runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" } },
});

try {
  let uploads = 0;
  await page.route("**/api/text/images", (route) => route.fulfill({ json: { image: names[uploads++] } }));
  await page.route("**/references/chat-image-*.png", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.evaluate((path) => { window.studio.pickLoraFiles = async () => [path]; }, adapter);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await button("Chat settings").click();
  await button("Image").click();
  await button("Add LoRA files").click();
  await page.getByLabel("Strength for character.safetensors", { exact: true }).fill("0.65");
  await page.getByLabel("Add image references", { exact: true }).setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: png },
    { name: "second.png", mimeType: "image/png", buffer: png },
  ]);
  await button("Move reference 2 up").click();
  await page.getByLabel("Use the image attached to the message", { exact: true }).check();
  await chooseSelectOption(page.getByLabel("Images per render", { exact: true }), "2 images");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Make a new image using the references.");
  await button("Send message").click();
  assert.deepEqual(state.textRequests[0].imageSettings, {
    width: 512, height: 512, steps: 4, guidance: 1, batchSize: 2,
    useMessageImage: true, referenceImages: [names[1], names[0]], loras: [{ path: adapter, strength: 0.65, enabled: true }],
  });
  const images = [1, 2].map((number) => ({ name: `batch-${number}.png`, width: 512, height: 512, modelLabel: "Klein", prompt: "Reference image" }));
  await page.route("**/outputs/batch-*.png*", (route) => route.fulfill({ contentType: "image/png", body: png }));
  state.textStatus.job = { ...state.textStatus.job, image: images[0], images, status: "complete", partialText: "Two images are ready.",
    result: { inputTokens: 10, outputTokens: 5, generationSeconds: 1, tokensPerSecond: 5, visionChecked: true } };
  await page.getByText("Two images are ready.", { exact: true }).waitFor();
  assert.equal(await page.locator(".text-generated-artifact").count(), 2);
  assert.equal(await page.getByText("Image checked", { exact: true }).count(), 1);
  const preview = button("Review image 1: Reference image");
  await preview.click();
  const viewer = page.getByRole("dialog", { name: /^Review image 1 of 2:/ });
  const imageActions = viewer.getByRole("button", { name: "Image actions for batch-1.png", exact: true });
  await imageActions.press("ArrowDown");
  const actions = viewer.getByRole("menu", { name: "Image actions", exact: true });
  await expect(actions.getByRole("menuitem", { name: "Copy prompt", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(imageActions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(preview).toBeFocused();
  await page.reload();
  await page.getByText("Two images are ready.", { exact: true }).waitFor();
  assert.equal(await page.locator(".text-generated-artifact").count(), 2);

  const workspace = await savedTextWorkspace(page);
  const active = workspace.threads.find((thread) => thread.id === workspace.activeId);
  active.imageRenderSettings["4b-lora"].width = 513;
  await savedTextWorkspace(page, workspace);
  await page.reload();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Retry with a corrected image width.");
  await button("Send message").click();
  await expect(page.getByRole("alert")).toContainText("Correct the image settings");
  assert.equal(state.textRequests.length, 1);
  await button("Open image settings").click();
  const settings = page.getByRole("complementary", { name: "Chat settings panel" });
  await expect(settings).toBeFocused();
  await expect(settings.getByRole("button", { name: "Image", exact: true })).toHaveAttribute("aria-pressed", "true");
  const width = settings.getByLabel("Width", { exact: true });
  await expect(width).toHaveAttribute("aria-invalid", "true");
  await expect(composer).toHaveValue("Retry with a corrected image width.");
  await width.fill("512");
  await expect(width).toHaveAttribute("aria-invalid", "false");
  await button("Close chat settings").click();
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.equal(state.textRequests[1].imageSettings.width, 512);
  assert.deepEqual(errors, []);
  console.log("Chat submits references, LoRA strength, and batch size and persists both images.");
} finally {
  await close();
}
