import { chooseSelectOption } from "./select-option.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true };
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], imageToolModels: [{ id: "kromoss-opd-dmd2", label: "Kromoss" }, { id: "4b", label: "Klein 4B" },
    { id: "qwen21-turbo", label: "Qwen Turbo", defaultWidth: 1024, defaultHeight: 1024, defaultSteps: 8, defaultGuidance: 1 },
    { id: "custom-example", label: "My SDXL", defaultWidth: 896, defaultHeight: 768, defaultSteps: 28, defaultGuidance: 7,
      minimumDimension: 512, maximumDimension: 1536, dimensionMultiple: 8 }],
    runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" } },
});
const context = page.getByRole("spinbutton", { name: /^Context length/ });
const output = page.getByRole("spinbutton", { name: /^Maximum output/ });
const button = (name) => page.getByRole("button", { name, exact: true });

try {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await button("Chat settings").click();
  assert.equal(await context.inputValue(), "8192");
  assert.equal(await context.getAttribute("max"), "65536");
  await context.fill("65537");
  assert.equal(await context.getAttribute("aria-invalid"), "true");
  await context.fill("24789");
  assert.equal(await output.getAttribute("max"), "24789");
  await output.fill("15100");
  const temperature = page.getByRole("slider", { name: "Temperature", exact: true });
  await temperature.press("Home");
  await temperature.press("ArrowRight");
  await expect(temperature).toHaveCSS("height", "32px");
  await expect(temperature).toHaveAccessibleDescription("Lower for focused answers, higher for variety.");
  await expect(page.getByLabel("Temperature value", { exact: true })).toHaveValue("0.01");
  await page.getByLabel("Temperature value", { exact: true }).fill("0.137");
  await page.getByLabel("Top P value", { exact: true }).fill("0.035");
  await page.getByText("Advanced model loading", { exact: true }).click();
  await chooseSelectOption(page.getByLabel("Flash Attention", { exact: true }), "On");
  await page.getByLabel("Prompt batch size", { exact: true }).fill("1024");
  await page.getByLabel("Microbatch size", { exact: true }).fill("256");
  await chooseSelectOption(page.getByLabel("KV key precision", { exact: true }), "q8_0");
  await page.getByText("Advanced sampling", { exact: true }).click();
  await page.getByLabel("Top K", { exact: true }).fill("32");
  await page.getByLabel("Min P", { exact: true }).fill("0.07");
  await page.getByLabel("Repetition penalty", { exact: true }).fill("1.15");
  const seed = page.getByLabel("Text seed", { exact: true });
  await seed.fill("37");
  await seed.press("End");
  await seed.press("e");
  await seed.press("Tab");
  await expect(seed).toHaveValue("37");
  await seed.fill("");
  await seed.press("Tab");
  await expect(seed).toHaveValue("");
  await seed.fill("37");
  await page.getByLabel("Stop sequences", { exact: true }).fill("END\nUser:");
  await page.getByLabel("System prompt", { exact: true }).fill("Keep the answer concise.");
  await page.getByText("Chat presets", { exact: true }).click();
  await page.getByLabel("New preset name", { exact: true }).fill("Concise answers");
  await button("Save as preset").click();
  await button("Save model defaults").click();
  await button("Image").click();
  await chooseSelectOption(page.getByRole("combobox", { name: "Resolution", exact: true }), "1024 × 768 · Landscape 4:3");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "1024");
  await page.getByLabel("Width", { exact: true }).fill("2064");
  await page.getByLabel("Step count", { exact: true }).fill("60");
  await page.getByLabel("Seed", { exact: true }).fill("123");
  await button("Lock seed").click();
  await page.getByText("Image style", { exact: true }).click();
  await page.getByLabel("Image prompt additions", { exact: true }).fill("Muted palette");
  await button("Cinematic").click();
  await button("Anime").click();
  await button("Anime").click();
  await chooseSelectOption(page.getByLabel("Image generation model", { exact: true }), "Klein 4B");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "512");
  await chooseSelectOption(page.getByLabel("Image generation model", { exact: true }), "Qwen Turbo");
  assert.equal(await page.getByLabel("Width", { exact: true }).getAttribute("step"), "32");
  assert.equal(await page.getByLabel("Step count", { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("Images per render", { exact: true }).isDisabled(), true);
  await chooseSelectOption(page.getByLabel("Image generation model", { exact: true }), "My SDXL");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "896");
  assert.equal(await page.getByLabel("Width", { exact: true }).getAttribute("step"), "8");
  const width = page.getByLabel("Width", { exact: true });
  await width.press("End");
  await width.press("e");
  await width.press("Tab");
  await expect(width).toHaveValue("896");
  assert.equal(await page.getByLabel("Step count", { exact: true }).inputValue(), "28");
  await page.getByRole("slider", { name: "Steps", exact: true }).press("ArrowRight");
  await expect(page.getByLabel("Step count", { exact: true })).toHaveValue("29");
  await chooseSelectOption(page.getByLabel("Image generation model", { exact: true }), "Kromoss");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "2064");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use these chat settings.");
  await button("Send message").click();
  assert.equal(state.textRequests[0].contextSize, 24789);
  assert.equal(state.textRequests[0].maxNewTokens, 15100);
  assert.equal(state.textRequests[0].temperature, 0.137);
  assert.equal(state.textRequests[0].topP, 0.035);
  assert.deepEqual(state.textRequests[0].loadOptions, { flashAttention: "on", promptBatch: 1024, microBatch: 256, keyCacheType: "q8_0" });
  assert.equal(state.textRequests[0].seed, 37);
  assert.deepEqual(state.textRequests[0].sampling, { topK: 32, minP: 0.07, repeatPenalty: 1.15, stopSequences: ["END", "User:"] });
  assert.deepEqual(state.textRequests[0].imageSettings, { width: 2064, height: 768, steps: 60, guidance: 1, seed: 123,
    promptSuffix: "Muted palette, cinematic lighting, film grain, dramatic, anamorphic" });

  await page.reload();
  await button("Chat settings").click();
  assert.equal(await context.inputValue(), "24789");
  assert.equal(await output.inputValue(), "15100");
  assert.equal(await page.getByLabel("Temperature value", { exact: true }).inputValue(), "0.137");
  assert.equal(await page.getByLabel("Top P value", { exact: true }).inputValue(), "0.035");
  await page.getByText("Advanced model loading", { exact: true }).click();
  assert.equal(await page.getByLabel("KV key precision", { exact: true }).innerText(), "q8_0");
  await page.getByText("Advanced sampling", { exact: true }).click();
  assert.equal(await page.getByLabel("Top K", { exact: true }).inputValue(), "32");
  await button("Image").click();
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "2064");
  assert.equal(await page.getByLabel("Step count", { exact: true }).inputValue(), "60");
  state.textStatus.job = {
    ...state.textStatus.job, status: "complete", partialText: "Done.",
    result: { inputTokens: 5, outputTokens: 1, generationSeconds: 1, tokensPerSecond: 1 },
  };
  await page.getByText("Done.", { exact: true }).waitFor();
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  if (!(await context.isVisible())) {
    const inspector = page.getByRole("complementary", { name: "Chat settings panel" });
    if (await inspector.isVisible()) await button("Model").click();
    else await button("Chat settings").click();
  }
  assert.equal(await context.inputValue(), "24789");
  assert.equal(await output.inputValue(), "15100");
  const systemPrompt = page.getByLabel("System prompt", { exact: true });
  assert.equal(await systemPrompt.inputValue(), "");
  await context.fill("28000");
  await output.fill("1000");
  const presets = page.getByText("Chat presets", { exact: true });
  if (!(await page.getByLabel("Saved preset").isVisible())) await presets.click();
  await chooseSelectOption(page.getByLabel("Saved preset"), "Concise answers");
  await button("Apply preset").click();
  await expect(systemPrompt).toHaveValue("Keep the answer concise.");
  await expect(context).toHaveValue("28000");
  await expect(output).toHaveValue("15100");
  assert.deepEqual(errors, []);
  console.log("Chat accepts, submits, and persists custom GGUF context and output lengths.");
} finally {
  await close();
}
