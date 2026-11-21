import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const model = {
  id: "klein-4b-mlx", label: "Klein 4B · MLX", installed: true, category: "image",
};
const { page, state, errors, close } = await fixture({
  firstRun: true, platform: "darwin", imageCount: 0, installedModels: [model],
  textStatus: {
    models: [{ id: "gemma", name: "Gemma 4 E4B", format: "gguf", installed: true, supportsVision: true, supportsTools: true }],
    ggufAvailable: true, runtimeAvailable: false, imageToolModels: [model], job: { id: null, status: "idle" },
  },
});
try {
  await page.route("**/api/flux2/status*", (route) => route.fulfill({ json: {
    job: state.job, images: [], runtime: state.runtime, installedModels: [model],
    model: {
      selectedModel: model.id, selectedDevice: "APPLE_GPU", runtimeBackend: "MLX",
      runtimeReady: true, supportsReferenceImage: false,
      adapters: [{ id: "APPLE_GPU", available: true, runtimeReady: true }],
    },
    defaults: { device: "AUTO", width: 512, height: 512, steps: 4, guidance: 1 },
  } }));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
  await page.reload();
  await button("New thread").click();
  await menuItem("Create image").click();
  await button("Image model: Klein 4B · MLX").click();
  assert.equal(await page.getByRole("menuitemradio").count(), 1);
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("A fox in winter");
  const rendered = page.waitForRequest((request) => request.url().endsWith("/api/flux2/generate"));
  await button("Generate image").click();
  const image = (await rendered).postDataJSON();
  assert.equal(image.model, model.id);
  assert.equal(image.device, "AUTO");
  assert.deepEqual([image.width, image.height, image.steps, image.guidance], [512, 512, 4, 1]);

  await button("New thread").click();
  await menuItem("Chat").click();
  await button("Chat settings").click();
  await button("Image").click();
  await page.getByLabel("Image generation model", { exact: true }).selectOption(model.id);
  await button("Close chat settings").click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Make a picture of a fox");
  const requested = page.waitForRequest((request) => request.url().endsWith("/api/text/generate"));
  await button("Send message").click();
  const chat = (await requested).postDataJSON();
  assert.equal(chat.imageModel, model.id);
  assert.equal(chat.device, "AUTO");
  assert.deepEqual(errors, []);
  console.log("Apple Silicon model selection, first-run image preset, and chat image tool routing passed.");
} finally {
  await close();
}
