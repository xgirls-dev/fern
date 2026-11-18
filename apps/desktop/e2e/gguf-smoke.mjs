import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-gguf-"));
const dataRoot = process.env.FERN_E2E_DATA_ROOT ?? path.join(scratch, "workspace");
const existingModelRoot = process.env.FERN_E2E_TEXT_MODEL_ROOT;
const sourceApp = process.env.FERN_E2E_APP_SOURCE;
const executable = process.env.FERN_E2E_EXECUTABLE ?? path.join(desktop, "release", "win-unpacked", "Fern.exe");
const catalogId = "gemma-4-e4b-gguf";
const env = {
  ...process.env,
  FERN_ROOT: dataRoot,
  INTEL_IRIS_ROOT: dataRoot,
  FERN_TEXT_MODEL_REGISTRY: path.join(scratch, "text-models.json"),
  FERN_E2E_HEADLESS: "1",
  ...(existingModelRoot ? { FERN_TEXT_MODEL_ROOT: existingModelRoot } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;

async function makeImage(page, color) {
  const data = await page.evaluate((circleColor) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 384;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 384, 384);
    context.fillStyle = "#ee2525";
    context.fillRect(32, 64, 120, 120);
    context.fillStyle = circleColor;
    context.beginPath();
    context.arc(280, 252, 72, 0, Math.PI * 2);
    context.fill();
    return canvas.toDataURL("image/png").split(",")[1];
  }, color);
  return { name: "shapes.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") };
}

let app;
let succeeded = false;
try {
  app = await electron.launch({
    executablePath: executable,
    args: [...(sourceApp ? [sourceApp] : []), `--user-data-dir=${path.join(scratch, "profile")}`,
      "--disable-gpu", "--use-angle=swiftshader", "--disable-features=Vulkan"],
    env,
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
  const status = async () => {
    const response = await fetch(`${api}/api/text/status`);
    assert(response.ok, `Text status returned HTTP ${response.status}`);
    return response.json();
  };
  const openThread = async () => {
    await page.locator(".sidebar-new-menu > button").click();
    await page.getByRole("menuitem", { name: "New text thread", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).waitFor();
  };

  await openThread();
  await page.getByRole("button", { name: "Browse models", exact: true }).click();
  const card = page.locator(".model-library-card").filter({
    has: page.getByRole("heading", { name: "Gemma 4 E4B · GGUF", exact: true }),
  });
  await card.getByRole("button", { name: "Download", exact: true }).click();
  let previousPhase;
  await expect.poll(async () => {
    const snapshot = await status();
    const install = snapshot.modelInstall;
    if (install.error) throw new Error(install.error);
    if (install.phase !== previousPhase) {
      console.log(install.phase ?? install.status);
      previousPhase = install.phase;
    }
    return snapshot.recommendedModels.find((model) => model.id === catalogId)?.installed;
  }, { timeout: 1_200_000, intervals: [2_000] }).toBe(true);
  await expect(card.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
  const installed = (await status()).models.find((model) => model.format === "gguf");
  assert(installed?.supportsVision && installed?.supportsReasoning, "Gemma must advertise vision and reasoning");
  await page.locator(".sidebar-text-threads .sidebar-thread-button").first().click();

  const cases = [
    { modality: "text", mode: "instant", prompt: "Name only the capital of France.", answer: /\bparis\b/i },
    { modality: "text", mode: "reasoning", prompt: "Six boxes contain seven pencils each. Nine pencils are sold. How many are left? Give just the number after reasoning.", answer: /\b33\b/ },
    { modality: "vision", mode: "instant", prompt: "What color is the circle? Reply with one color.", color: "#2255ee", answer: /\bblue\b/i },
    { modality: "vision", mode: "reasoning", prompt: "Compare the two shapes. Which colored shape is lower, and what is its shape?", color: "#158e36", answer: /\bgreen\b.*\bcircle\b/i },
  ];
  const report = [];
  for (const [index, test] of cases.entries()) {
    if (index) await openThread();
    await page.getByRole("button", { name: "Generation settings" }).click();
    await page.getByLabel("Temperature", { exact: true }).press("Home");
    await page.getByRole("button", { name: "Close chat settings" }).click();
    await page.getByLabel("Response mode", { exact: true }).selectOption(test.mode);
    if (test.color) {
      await page.getByLabel("Chat image file").setInputFiles(await makeImage(page, test.color));
      await expect(page.getByAltText("Image to send")).toBeVisible();
    }
    await page.getByLabel("Message", { exact: true }).fill(test.prompt);
    console.log(`Sending ${test.modality} ${test.mode}…`);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const message = page.locator(".text-message--assistant").last();
    await expect(message.getByRole("button", { name: "Response details", exact: true })).toBeVisible({ timeout: 360_000 });
    const response = await status();
    assert.equal(response.job.status, "complete", JSON.stringify(response.job));
    assert.equal(response.job.modelId, installed.id);
    assert.equal(response.job.result.mode, test.mode);
    assert.equal(response.job.result.device, "GPU");
    assert.equal(response.job.result.backend, test.modality === "text" ? "OpenVINO" : "Vulkan");
    assert(response.job.result.outputTokens > 0 && response.job.result.inputTokens > 0, "Token counts must be positive");
    assert.match(response.job.partialText, test.answer);
    await expect(message.locator(".text-message-content")).toContainText(test.answer);
    await expect(message.locator("details.text-reasoning")).toHaveCount(test.mode === "reasoning" ? 1 : 0);
    assert.equal(Boolean(response.job.partialReasoning?.trim()), test.mode === "reasoning");
    if (test.color) await expect(page.getByAltText("Attached chat image")).toBeVisible();
    const { backend, device, generationSeconds, tokensPerSecond } = response.job.result;
    report.push({ modality: test.modality, mode: test.mode, backend, device, generationSeconds, tokensPerSecond, answer: response.job.partialText });
    console.log(JSON.stringify(report.at(-1)));
  }
  await expect(page.locator(".text-message--streaming")).toHaveCount(0);
  const screenshot = sourceApp
    ? await page.screenshot()
    : Buffer.from(await window.evaluate(async (browserWindow) => {
      const image = await browserWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return image.toPNG().toString("base64");
    }), "base64");

  const removed = await fetch(`${api}/api/text/models/remove`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: installed.id }),
  });
  assert(removed.ok, "Unregistering Gemma should keep the model files available for import");
  await page.getByRole("button", { name: "Text model", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage models", exact: true }).click();
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [installed.projectorPath, installed.path]);
  const importResponse = page.waitForResponse((response) => response.url().endsWith("/api/text/models/import"));
  await page.getByRole("button", { name: "Import GGUF", exact: true }).click();
  const imported = await importResponse;
  assert(imported.ok(), await imported.text());
  const reimported = (await status()).models.find((model) => model.id === installed.id);
  assert(reimported?.supportsVision && reimported?.supportsReasoning, "Import must restore the model and its projector");
  console.log("Local GGUF and projector import passed.");
  const artifacts = path.resolve(desktop, "..", "..", "artifacts", "release-test");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "gemma-4-e4b-gguf.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(artifacts, "gemma-4-e4b-vision-reasoning.png"), screenshot);
  succeeded = true;
} finally {
  if (app) await app.close().catch(() => {});
  if (succeeded) await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`GGUF smoke test scratch files retained at ${scratch}`);
}
