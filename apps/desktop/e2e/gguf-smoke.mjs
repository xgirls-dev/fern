import { chooseSelectOption } from "../../../tests/select-option.mjs";
import { chooseMessageAction, savedTextWorkspace } from "../../../tests/ui-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { measureUnloadAndReload, measureWarmStop, observeChatReply, readReplyTiming, verifyPromptDetails } from "./chat-reply-timing.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-gguf-"));
const dataRoot = process.env.FERN_E2E_DATA_ROOT ?? path.join(scratch, "workspace");
const existingModelRoot = process.env.FERN_E2E_TEXT_MODEL_ROOT;
const sourceApp = process.env.FERN_E2E_APP_SOURCE;
const mac = process.platform === "darwin";
const textBackend = mac ? "Metal" : (process.env.FERN_E2E_GGUF_TEXT_BACKEND ?? "OpenVINO");
assert(["Metal", "OpenVINO", "Vulkan"].includes(textBackend), "Choose a supported expected GGUF backend.");
const packagedExecutable = mac
  ? path.join(desktop, "release-macos", "mac-arm64", "Fern.app", "Contents", "MacOS", "Fern")
  : path.join(desktop, "release", "win-unpacked", "Fern.exe");
const executable = process.env.FERN_E2E_EXECUTABLE ?? packagedExecutable;
const catalogId = "gemma-4-e4b-gguf";
const firstPrompt = "Name only the capital of France.";
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
  if (!sourceApp) {
    assert(await app.evaluate(({ app }) => app.isPackaged), "Launch a packaged Fern executable.");
  }
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
  const captureWindow = async () => sourceApp
    ? page.screenshot()
    : Buffer.from(await window.evaluate(async (browserWindow) => {
      const image = await browserWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return image.toPNG().toString("base64");
    }), "base64");
  const artifacts = process.env.FERN_E2E_ARTIFACTS ?? path.resolve(desktop, "..", "..", "artifacts", "release-test");
  await mkdir(artifacts, { recursive: true });
  const status = async () => {
    const response = await fetch(`${api}/api/text/status`);
    assert(response.ok, `Text status returned HTTP ${response.status}`);
    return response.json();
  };
  const openThread = async () => {
    await page.locator(".sidebar-new-menu > button").click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  };

  await openThread();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const initial = await status();
  assert.equal(initial.models.length, 0, "Start with an empty model library.");
  const suggested = initial.recommendedModels.find((model) => model.id === catalogId);
  assert(suggested && !suggested.installed, "Gemma should be available to download from the catalog.");
  if (mac) assert.equal(initial.defaultModelId, catalogId, "Use the recommended Mac chat model.");
  await composer.fill(firstPrompt);
  await page.getByRole("button", { name: "Browse models", exact: true }).click();
  const card = page.locator(".model-library-card").filter({
    has: page.getByRole("heading", { name: suggested.name, exact: true }),
  });
  if (mac) await expect(card.getByText("Recommended", { exact: true })).toBeVisible();
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
  await expect(card.getByRole("status")).toHaveText("Ready to load");
  const ready = await status();
  const installed = ready.models.find((model) => model.format === "gguf");
  assert(installed?.supportsVision && installed?.supportsReasoning, "Gemma must advertise vision and reasoning");
  assert.equal(ready.job.status, "idle", "Model setup should wait for an explicit Send.");
  await page.getByRole("button", { name: "Use model in draft", exact: true }).click();
  await expect(composer).toHaveValue(firstPrompt);
  await expect(composer).toBeFocused();
  console.log("Model setup returned to the focused, unsent first draft.");

  const cases = [
    { modality: "text", mode: "instant", prompt: firstPrompt, answer: /\bparis\b/i },
    { modality: "text", mode: "reasoning", prompt: "Six boxes contain seven pencils each. Nine pencils are sold. How many are left? Give just the number after reasoning.", answer: /\b33\b/ },
    { modality: "vision", mode: "instant", prompt: "What color is the circle? Reply with one color.", color: "#2255ee", answer: /\bblue\b/i },
    { modality: "vision", mode: "reasoning", prompt: "Compare the two shapes. Which colored shape is lower, and what is its shape?", color: "#158e36", answer: /\bgreen\b.*\bcircle\b/i },
  ];
  const report = [];
  for (const [index, test] of cases.entries()) {
    if (index) await openThread();
    await page.getByRole("button", { name: "Chat settings" }).click();
    await page.getByLabel("Temperature", { exact: true }).press("Home");
    await page.getByRole("button", { name: "Close chat settings" }).click();
    await chooseSelectOption(page.getByLabel("Response mode", { exact: true }), test.mode === "reasoning" ? "Reasoning" : "Instant");
    if (test.color) {
      await page.getByLabel("Chat image file").setInputFiles(await makeImage(page, test.color));
      await expect(page.getByAltText("Image to send")).toBeVisible();
    }
    if (index) await composer.fill(test.prompt);
    console.log(`Sending ${test.modality} ${test.mode}…`);
    const send = page.getByRole("button", { name: "Send message", exact: true });
    const timing = await observeChatReply(send);
    await send.click();
    const message = page.locator(".text-message--assistant").last();
    await expect(message.getByRole("button", { name: "More message actions", exact: true })).toBeVisible({ timeout: 360_000 });
    const response = await status();
    assert.equal(response.job.status, "complete", JSON.stringify(response.job));
    assert.equal(response.job.modelId, installed.id);
    assert.equal(response.job.result.mode, test.mode);
    assert.equal(response.job.result.device, "GPU");
    const expectedBackend = test.modality === "text" || mac ? textBackend : "Vulkan";
    assert.equal(response.job.result.backend, expectedBackend);
    assert(response.job.result.outputTokens > 0 && response.job.result.inputTokens > 0, "Token counts must be positive");
    assert.match(response.job.partialText, test.answer);
    await expect(message.locator(".text-message-content")).toContainText(test.answer);
    await expect(message.locator("details.text-reasoning")).toHaveCount(test.mode === "reasoning" ? 1 : 0);
    assert.equal(Boolean(response.job.partialReasoning?.trim()), test.mode === "reasoning");
    if (test.color) await expect(page.getByAltText("Attached chat image")).toBeVisible();
    const { backend, device, generationSeconds, tokensPerSecond, inputTokens, outputTokens, runtimeTiming } = response.job.result;
    const rendererTiming = await readReplyTiming(timing);
    report.push({ modality: test.modality, mode: test.mode, backend, device, generationSeconds, tokensPerSecond,
      inputTokens, outputTokens, runtimeTiming, rendererTiming, answer: response.job.partialText });
    console.log(JSON.stringify(report.at(-1)));
    if (index === 0) {
      assert(Number.isFinite(runtimeTiming?.modelReadyMs), "The first reply should report its cold GGUF model load.");
      const coldDetails = await verifyPromptDetails(message, runtimeTiming);
      await chooseMessageAction(message, "Hide response details");
      const warmStop = await measureWarmStop(page, async () => (await status()).job, installed.id);
      assert.equal(warmStop.followUp.backend, expectedBackend);
      assert.equal(warmStop.followUp.device, "GPU");
      report.push({ modality: "text", mode: "instant", journey: "warm-stop-and-follow-up", ...warmStop });
      console.log(JSON.stringify(report.at(-1)));
      const warmJob = (await status()).job;
      await expect.poll(async () => {
        const workspace = await savedTextWorkspace(page);
        return workspace?.threads.find(({ id }) => id === warmJob.threadId)?.messages.at(-1)?.jobId;
      }).toBe(warmJob.id);
      await page.reload({ waitUntil: "domcontentloaded" });
      const reopened = page.locator(`[data-chat-message=${JSON.stringify(`response-${warmJob.id}`)}]`);
      await expect(reopened.locator(".text-message-content")).toContainText(/\bORCHID-42\b/i);
      const reopenedDetails = await verifyPromptDetails(reopened, warmStop.followUp.runtime);
      await reopened.getByRole("region", { name: "Response details" }).scrollIntoViewIfNeeded();
      await writeFile(path.join(artifacts, "gemma-4-e4b-response-details.png"), await captureWindow());
      await writeFile(path.join(artifacts, "gemma-4-e4b-response-details.json"), JSON.stringify({
        backend: expectedBackend, device, coldDetails, reopenedDetails, cold: runtimeTiming, warm: warmStop.followUp.runtime,
      }, null, 2) + "\n");
      await chooseMessageAction(reopened, "Hide response details");
      const eviction = await measureUnloadAndReload(page, status, installed.id, { prompt: firstPrompt, answer: /\bparis\b/i });
      assert.equal(eviction.reload.backend, expectedBackend);
      assert.equal(eviction.reload.device, "GPU");
      report.push({ modality: "text", mode: "instant", journey: "unload-and-reload", ...eviction });
      console.log(JSON.stringify(report.at(-1)));
    }
  }
  await expect(page.locator(".text-message--streaming")).toHaveCount(0);
  const screenshot = await captureWindow();

  const removed = await fetch(`${api}/api/text/models/remove`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: installed.id }),
  });
  assert(removed.ok, "Unregistering Gemma should keep the model files available for import");
  await page.getByRole("button", { name: /^Text model:/ }).click();
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
  await writeFile(path.join(artifacts, "gemma-4-e4b-gguf.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(artifacts, "gemma-4-e4b-vision-reasoning.png"), screenshot);
  succeeded = true;
} finally {
  if (app) await app.close().catch(() => {});
  if (succeeded) await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`GGUF smoke test scratch files retained at ${scratch}`);
}
