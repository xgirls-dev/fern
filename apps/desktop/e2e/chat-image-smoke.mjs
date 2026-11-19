import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.FERN_E2E_EXECUTABLE ?? path.join(desktop, "release", "win-unpacked", "Fern.exe");
const source = process.env.FERN_E2E_APP_SOURCE;
const root = process.env.FERN_E2E_DATA_ROOT;
const gguf = process.env.FERN_E2E_GGUF;
const projector = process.env.FERN_E2E_GGUF_PROJECTOR;
assert(root && gguf && projector, "Set FERN_E2E_DATA_ROOT, FERN_E2E_GGUF, and FERN_E2E_GGUF_PROJECTOR.");
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-chat-image-"));
const env = { ...process.env, FERN_ROOT: root, FERN_TEXT_MODEL_REGISTRY: path.join(scratch, "text-models.json"), FERN_E2E_HEADLESS: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    executablePath: executable, env,
    args: [...(source ? [source] : []), `--user-data-dir=${path.join(scratch, "profile")}`, "--disable-gpu", "--use-angle=swiftshader"],
    timeout: 180_000,
  });
  let page = await app.firstWindow();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => typeof window.studio?.getApiBaseUrl === "function").catch(() => false)) break;
    page = app.windows().at(-1) ?? page;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const api = await page.evaluate(() => window.studio.getApiBaseUrl());
  const window = await app.browserWindow(page);
  await window.evaluate((browserWindow) => browserWindow.webContents.setBackgroundThrottling(false));
  const request = async (route, data) => {
    const response = await fetch(api + route, data && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await response.json();
    assert(response.ok, JSON.stringify(body));
    return body;
  };
  const { model } = await request("/api/text/models/import", { ggufPaths: [gguf, projector] });
  assert(model.supportsTools && model.supportsVision);
  const initial = await request("/api/text/status");
  assert.match(initial.imageToolModels[0].id, /^4b(?:-lora)?$/);
  await page.locator(".sidebar-new-menu > button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Chat settings" }).click();
  await expect(page.getByRole("combobox", { name: "Image generation model" })).toHaveValue("auto");
  await page.getByLabel("Temperature", { exact: true }).press("Home");
  await page.getByRole("button", { name: "Close chat settings" }).click();

  const answers = page.locator(".text-message--assistant:not(.text-message--streaming)");
  const send = async (message, turn, expectedImages = null) => {
    await page.getByLabel("Message", { exact: true }).fill(message);
    const start = performance.now();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const timing = {};
    const acknowledge = expect(page.locator(".text-message--user").last()).toContainText(message)
      .then(() => { timing.acknowledgmentMs = Math.round(performance.now() - start); });
    const imageVisible = expectedImages === null ? Promise.resolve() : page.waitForFunction((count) => {
      const images = [...document.querySelectorAll(".text-generated-artifact img")];
      const last = images.at(-1);
      if (images.length !== count || !last?.complete || last.naturalWidth === 0) return false;
      const image = last.getBoundingClientRect();
      const conversation = last.closest(".text-conversation")?.getBoundingClientRect();
      return conversation && image.bottom > conversation.top && image.top < conversation.bottom;
    }, expectedImages, { timeout: 240_000 }).then(() => { timing.firstPixelsMs = Math.round(performance.now() - start); });
    const reply = expect(answers).toHaveCount(turn, { timeout: 240_000 })
      .then(() => { timing.completedResponseMs = Math.round(performance.now() - start); });
    await Promise.all([acknowledge, imageVisible, reply]);
    const { job } = await request("/api/text/status");
    assert.equal(job.status, "complete", JSON.stringify(job));
    return { job, timing };
  };
  const main = await send("Let's design a red ceramic teapot on a wooden table. For now, just acknowledge the idea in one sentence.", 1);
  assert.equal(main.job.image, null);
  const first = await send("Create the image of that red teapot now.", 2, 1);
  assert(first.job.image);
  assert.deepEqual([first.job.image.width, first.job.image.height], [512, 512]);
  assert.match(first.job.image.prompt, /teapot/i);
  assert.equal(first.job.result.device, "GPU");
  assert.equal(first.job.result.backend, "Vulkan");
  assert.equal(first.job.result.visionChecked, true);
  assert(first.job.result.context.images > 0);
  const image = answers.nth(1).getByRole("button", { name: /^Review image \d+: .*teapot/i }).locator("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(512);
  const second = await send("Generate another square image, this time a blue ceramic mug on a white counter.", 3, 2);
  assert(second.job.image && second.job.image.name !== first.job.image.name);
  assert.equal(second.job.result.visionChecked, true);
  assert.match(second.job.image.prompt, /mug/i);
  await expect(page.getByRole("button", { name: /^Review image \d+:/ })).toHaveCount(2);
  const last = await send("What color was the teapot in our first image? Answer with the color only.", 4);
  assert.equal(last.job.image, null);
  assert.equal(last.job.result.context.images, 2);
  assert.match(last.job.partialText, /red/i);

  const screenshot = path.resolve(desktop, "..", "..", "artifacts", "release-test");
  await mkdir(screenshot, { recursive: true });
  if (source) await page.screenshot({ path: path.join(screenshot, "chat-image.png") });

  const warmRuns = [];
  const samples = Number(process.env.FERN_E2E_CHAT_WARM_RUNS ?? "0");
  assert(Number.isInteger(samples) && samples >= 0 && samples <= 10);
  for (let index = 0; index < samples; index++) {
    const run = await send("Generate a new square poster with a red circle centered on cream.", 5 + index, 3 + index);
    assert.equal(run.job.result.visionChecked, true);
    warmRuns.push(run.timing);
  }

  const oldTurns = [
    { role: "user", content: "The project codename is NIMBUS-417. Remember that exact project code." },
    { role: "assistant", content: "The project codename is NIMBUS-417." },
    ...Array.from({ length: 5 }, (_, index) => [
      { role: "user", content: `Design notes ${index}. ` + "The scale sample contains examples of oak surfaces, brass trim, linen backgrounds, and ceramic textures. ".repeat(48) },
      { role: "assistant", content: "I have the relevant design choices." },
    ]).flat(),
    { role: "user", content: "Generate the red teapot." },
    { role: "assistant", content: "The image is ready.", generatedImage: first.job.image.name },
    { role: "user", content: "Give the exact project codename and the color of the teapot visible in the image. Use one short sentence." },
  ];
  const contextChecks = [];
  for (const contextSize of [4096, 8192, 16384]) {
    const requestId = crypto.randomUUID();
    await request("/api/text/generate", {
      threadId: first.job.threadId, modelId: model.id, requestId, contextSize, messages: oldTurns,
      temperature: 0, maxNewTokens: 96, seed: 24,
    });
    await expect.poll(async () => {
      const { job } = await request("/api/text/status");
      return job.id === requestId && job.status !== "running";
    }, { timeout: 240_000 }).toBe(true);
    const { job } = await request("/api/text/status");
    assert.equal(job.status, "complete", JSON.stringify(job));
    assert.equal(job.result.context.size, contextSize);
    assert.equal(job.result.context.images, 1);
    assert.deepEqual(job.result.context.imageNames, [first.job.image.name]);
    assert.match(job.partialText, /NIMBUS-417/i);
    assert.match(job.partialText, /red/i);
    contextChecks.push({ ...job.result.context, answer: job.partialText });
  }
  assert(contextChecks[0].compactedMessages > 0, "The 4K run must compact older turns");

  const report = {
    platform: process.platform, architecture: process.arch, hardware: process.env.FERN_E2E_HARDWARE ?? "unreported",
    model: model.name, imageModel: initial.imageToolModels[0].label, visionBackend: first.job.result.backend,
    first: { ...first.timing, image: first.job.image }, second: { ...second.timing, image: second.job.image },
    followUp: last.job.partialText, contextChecks, warmRuns, modelLoadsAndEvictions: "unmeasured",
  };
  console.log(JSON.stringify(report, null, 2));
  const artifacts = path.resolve(desktop, "..", "..", "artifacts", "release-test");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "chat-image.json"), JSON.stringify(report, null, 2) + "\n");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
