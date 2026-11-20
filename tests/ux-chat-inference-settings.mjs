import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true };
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], imageToolModels: [{ id: "kromoss-opd-dmd2", label: "Kromoss" }, { id: "4b", label: "Klein 4B" }],
    runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" } },
});
const context = page.getByRole("spinbutton", { name: /^Context length/ });
const output = page.getByRole("spinbutton", { name: /^Maximum output/ });
const button = (name) => page.getByRole("button", { name, exact: true });

try {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: /New text thread|Chat/ }).click();
  await button("Chat settings").click();
  assert.equal(await context.inputValue(), "8192");
  assert.equal(await context.getAttribute("max"), "65536");
  await context.fill("65537");
  assert.equal(await context.getAttribute("aria-invalid"), "true");
  await context.fill("24789");
  await output.fill("9100");
  await page.getByText("Advanced model loading", { exact: true }).click();
  await page.getByLabel("Flash Attention", { exact: true }).selectOption("on");
  await page.getByLabel("Prompt batch size", { exact: true }).fill("1024");
  await page.getByLabel("Microbatch size", { exact: true }).fill("256");
  await page.getByLabel("KV key precision", { exact: true }).selectOption("q8_0");
  await page.getByText("Advanced sampling", { exact: true }).click();
  await page.getByLabel("Top K", { exact: true }).fill("32");
  await page.getByLabel("Min P", { exact: true }).fill("0.07");
  await page.getByLabel("Repetition penalty", { exact: true }).fill("1.15");
  await page.getByLabel("Text seed", { exact: true }).fill("37");
  await page.getByLabel("Stop sequences", { exact: true }).fill("END\nUser:");
  await button("Save model defaults").click();
  await button("Image").click();
  await page.getByRole("combobox", { name: "Resolution", exact: true }).selectOption("1024x768");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "1024");
  await page.getByLabel("Width", { exact: true }).fill("2064");
  await page.getByLabel("Step count", { exact: true }).fill("60");
  await page.getByLabel("Seed", { exact: true }).fill("123");
  await button("Lock seed").click();
  await page.getByLabel("Image generation model", { exact: true }).selectOption("4b");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "512");
  await page.getByLabel("Image generation model", { exact: true }).selectOption("kromoss-opd-dmd2");
  assert.equal(await page.getByLabel("Width", { exact: true }).inputValue(), "2064");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use these chat settings.");
  await button("Send message").click();
  assert.equal(state.textRequests[0].contextSize, 24789);
  assert.equal(state.textRequests[0].maxNewTokens, 9100);
  assert.deepEqual(state.textRequests[0].loadOptions, { flashAttention: "on", promptBatch: 1024, microBatch: 256, keyCacheType: "q8_0" });
  assert.equal(state.textRequests[0].seed, 37);
  assert.deepEqual(state.textRequests[0].sampling, { topK: 32, minP: 0.07, repeatPenalty: 1.15, stopSequences: ["END", "User:"] });
  assert.deepEqual(state.textRequests[0].imageSettings, { width: 2064, height: 768, steps: 60, guidance: 1, seed: 123 });

  await page.reload();
  await button("Chat settings").click();
  assert.equal(await context.inputValue(), "24789");
  assert.equal(await output.inputValue(), "9100");
  await page.getByText("Advanced model loading", { exact: true }).click();
  assert.equal(await page.getByLabel("KV key precision", { exact: true }).inputValue(), "q8_0");
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
  await page.getByRole("menuitem", { name: /New text thread|Chat/ }).click();
  if (!(await context.isVisible())) {
    const inspector = page.getByRole("complementary", { name: "Chat settings panel" });
    if (await inspector.isVisible()) await button("Model").click();
    else await button("Chat settings").click();
  }
  assert.equal(await context.inputValue(), "24789");
  assert.equal(await output.inputValue(), "9100");
  assert.deepEqual(errors, []);
  console.log("Chat accepts, submits, and persists custom GGUF context and output lengths.");
} finally {
  await close();
}
