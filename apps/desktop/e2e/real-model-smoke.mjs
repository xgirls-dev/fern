import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const executable = process.env.FERN_E2E_EXECUTABLE ?? path.join(desktopRoot, "release", "win-unpacked", "Fern.exe");
const modelId = process.env.FERN_E2E_MODEL ?? "4b";
const device = process.env.FERN_E2E_DEVICE ?? "AUTO";
const largeModelThresholdBytes = 50_000_000_000;
const minimumFreeSpaceAfterDownloadBytes = 4 * 1024 ** 3;
const prompt = process.env.FERN_E2E_PROMPT ?? "A red cube on a plain gray background";
const width = process.env.FERN_E2E_WIDTH ?? "768";
const height = process.env.FERN_E2E_HEIGHT ?? "768";
const steps = process.env.FERN_E2E_STEPS ?? "4";
const guidance = process.env.FERN_E2E_GUIDANCE ?? "1";
const seed = process.env.FERN_E2E_SEED ?? "994286815";
const artifactLabel = process.env.FERN_E2E_ARTIFACT_LABEL ?? "electron";
const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "fern-real-model-e2e-"));
const appDataRoot = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const defaultDataRoot = path.join(appDataRoot, "Fern", "studio-data");
const dataRoot = path.resolve(process.env.FERN_E2E_DATA_ROOT ?? (
  existsSync(path.join(defaultDataRoot, "models")) ? defaultDataRoot : repoRoot
));
const profileRoot = process.env.FERN_E2E_PROFILE ?? path.join(scratchRoot, "profile");
const appEnv = {
  ...process.env,
  FERN_ROOT: dataRoot,
  INTEL_IRIS_ROOT: dataRoot,
  FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratchRoot, "custom-image-models.json"),
  FERN_TEXT_MODEL_REGISTRY: path.join(scratchRoot, "text-models.json"),
};
delete appEnv.FERN_E2E_HEADLESS;
delete appEnv.ELECTRON_RUN_AS_NODE;
// The sandbox sets this environment variable globally. FLUX.3 runtime setup
// must be able to fetch the pinned official CPU torchvision wheel.
delete appEnv.PIP_NO_INDEX;

let app;
let succeeded = false;
let page;

try {
  app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profileRoot}`, "--disable-gpu-compositing", "--use-gl=swiftshader", "--use-angle=swiftshader"],
    cwd: repoRoot,
    env: appEnv,
    timeout: 240_000,
  });

  page = await app.firstWindow();
  const rendererDeadline = Date.now() + 240_000;
  while (Date.now() < rendererDeadline) {
    try {
      if (await page.evaluate(() => typeof window.studio?.getApiBaseUrl === "function")) break;
    } catch { /* Packaged runtime setup can replace its first-run window. */ }
    const windows = app.windows();
    if (windows.length) page = windows[windows.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(await page.evaluate(() => typeof window.studio?.getApiBaseUrl === "function"), true, "Packaged Fern should open its main renderer");

  const apiBase = await page.evaluate(() => window.studio.getApiBaseUrl());
  const getModels = async () => {
    const response = await fetch(`${apiBase}/api/models`);
    assert.equal(response.ok, true, `Model status returned HTTP ${response.status}`);
    const snapshot = await response.json();
    const model = snapshot.models.find((entry) => entry.id === modelId);
    assert.ok(model, `Model ${modelId} should be in the image model library`);
    return model;
  };
  const openModelsView = async () => {
    const modelsButton = page.getByRole("button", { name: "Models", exact: true });
    if (await modelsButton.count()) {
      await modelsButton.click();
    } else {
      await page.getByRole("button", { name: "Preferences", exact: true }).click();
    }
    await page.getByRole("heading", { name: "Image models" }).waitFor();
  };

  await openModelsView();
  let model = await getModels();
  const modelCard = page.locator("article.model-library-card").filter({ has: page.getByRole("heading", { name: model.label, exact: true }) });
  await modelCard.waitFor({ state: "visible", timeout: 30_000 });

  if (!model.installed) {
    if (!Number.isSafeInteger(model.bytes) || model.bytes <= 0) {
      throw new Error(`Refusing to download model ${modelId} without a verified catalog size.`);
    }
    if (model.bytes >= largeModelThresholdBytes) {
      throw new Error(`Refusing to start a ${model.bytes}-byte model download in the automated smoke. Run a separate UI install/generation pass and handle its post-test cleanup with action-time confirmation.`);
    }
    const disk = await statfs(dataRoot);
    const availableBytes = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(availableBytes) || availableBytes - model.bytes < minimumFreeSpaceAfterDownloadBytes) {
      throw new Error(`Refusing to download ${model.bytes} bytes with only ${availableBytes} bytes free; keep at least ${minimumFreeSpaceAfterDownloadBytes} bytes free after setup.`);
    }
    await modelCard.getByRole("button", { name: /Install|Retry setup|Resume setup/ }).click();
  }
  const installDeadline = Date.now() + 2 * 60 * 60 * 1000;
  let lastDownloaded = -1;
  while (Date.now() < installDeadline) {
    model = await getModels();
    if (model.state === "installed") break;
    if (["failed", "runtime-unavailable"].includes(model.state)) {
      throw new Error(model.error || model.logs?.at(-1) || `Model setup ended ${model.state}`);
    }
    if (model.downloaded !== lastDownloaded) {
      console.log(`Model install: ${model.phase || model.state} (${model.downloaded}/${model.bytes} bytes)`);
      lastDownloaded = model.downloaded;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  assert.equal(model.state, "installed", `Model setup did not finish: ${model.error || model.state}`);
  model = await getModels();
  console.log(`Model installed through Electron UI: ${modelId} (${model.bytes} bytes)`);

  const newThreadMenu = page.locator(".sidebar-new-menu > button");
  if (await newThreadMenu.count()) {
    await newThreadMenu.click();
    await page.getByRole("menuitem", { name: "New image thread" }).click();
  } else {
    await page.getByRole("button", { name: "New image thread", exact: true }).click();
  }
  const modelTrigger = page.locator(".composer-model-trigger");
  await modelTrigger.click();
  await page.getByRole("menuitemradio", { name: model.label, exact: true }).click();
  if (device === "CPU") {
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    const cpuPreference = page.getByRole("button", { name: /Allow CPU selection/ });
    if (await cpuPreference.getAttribute("aria-pressed") !== "true") await cpuPreference.click();
    await page.getByLabel("Generation device", { exact: true }).selectOption("CPU");
    await page.locator('.sidebar-threads[aria-label="Image threads"] .sidebar-thread-button').first().click();
  }
  await page.getByRole("button", { name: "Image settings" }).last().click();
  await expect(page.locator("#device")).toHaveCount(0);
  await page.locator(".control-section").filter({ hasText: "Advanced" }).locator("summary").click();
  await page.locator("#width").fill(width);
  await page.locator("#height").fill(height);
  await page.getByLabel("Step count").fill(steps);
  await page.getByLabel("Guidance value").fill(guidance);
  await page.getByRole("button", { name: "Seed settings" }).click();
  await page.getByRole("textbox", { name: "Seed", exact: true }).fill(seed);
  await page.locator("#prompt").fill(prompt);
  const generationStatusUrl = `${apiBase}/api/flux2/status?model=${encodeURIComponent(modelId)}&device=${encodeURIComponent(device)}&images=0`;
  let generationStatus;
  const readinessDeadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < readinessDeadline) {
    const generationStatusResponse = await fetch(generationStatusUrl);
    assert.equal(generationStatusResponse.ok, true, `Runtime status returned HTTP ${generationStatusResponse.status}`);
    generationStatus = await generationStatusResponse.json();
    if (!generationStatus.model?.checking) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (generationStatus.model?.checking || !generationStatus.model?.runtimeReady) {
    throw new Error(`Generation runtime is not ready: ${JSON.stringify(generationStatus.model)}`);
  }
  const selectedDevice = generationStatus.model.selectedDevice;
  if (device === "CPU") {
    assert.equal(selectedDevice, "CPU", "Explicit CPU opt-in should select CPU for this test");
  } else {
    assert.ok(["INTEL_GPU", "NVIDIA_GPU"].includes(selectedDevice), `GPU-only smoke must select an available GPU, got ${selectedDevice || "no device"}`);
  }
  const generateButton = page.getByRole("button", { name: "Generate image" });
  if (await generateButton.isDisabled()) {
    await page.screenshot({ path: path.join(scratchRoot, "generation-disabled.png"), fullPage: true });
    const mainText = await page.locator("main").innerText().catch(() => "<main text unavailable>");
    throw new Error(`Generation remains disabled after runtime readiness: model=${JSON.stringify(generationStatus.model)}; runtime=${JSON.stringify(generationStatus.runtime)}; main=${mainText}`);
  }
  await generateButton.click();

  const generationDeadline = Date.now() + 90 * 60 * 1000;
  let lastLogCount = 0;
  let finalStatus;
  while (Date.now() < generationDeadline) {
    const status = await fetch(`${apiBase}/api/flux2/status?model=${encodeURIComponent(modelId)}&device=${encodeURIComponent(device)}&images=0`);
    finalStatus = await status.json();
    if (["failed", "cancelled"].includes(finalStatus.job?.status)) {
      console.error(finalStatus.job?.logs?.join("\n"));
      throw new Error(finalStatus.job?.error || `Generation ended ${finalStatus.job?.status}`);
    }
    const logs = finalStatus.job?.logs ?? [];
    for (const line of logs.slice(lastLogCount)) console.log(line);
    lastLogCount = logs.length;
    if (finalStatus.job?.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assert.equal(finalStatus.job.status, "complete");
  const outputName = finalStatus.job.output?.name;
  assert.ok(outputName, "Completed generation should return its output filename");
  assert.equal(finalStatus.job.output?.device, selectedDevice, "Completed image metadata should record the selected compute device");
  const outputPath = path.join(dataRoot, "outputs", outputName);
  const output = await stat(outputPath);
  assert.ok(output.size > 0, "Generated image should be saved under Fern's output folder");
  console.log(`Generation passed: ${outputName} (${output.size} bytes), device=${device === "CPU" ? "CPU (explicit Preferences selection)" : "available GPU"}`);
  const artifactDir = path.join(repoRoot, "artifacts", "release-test");
  await mkdir(artifactDir, { recursive: true });
  await copyFile(outputPath, path.join(artifactDir, `${modelId}-${artifactLabel}-real-inference.png`));

  succeeded = true;
  console.log(`Real model smoke passed in visible packaged Electron: ${modelId}; device=${selectedDevice}`);
} finally {
  if (app) await app.close().catch(() => {});
  if (succeeded) {
    await rm(scratchRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    console.log(`Removed temporary model/runtime test data: ${scratchRoot}`);
  } else {
    console.error(`Test data retained for retry/diagnosis: ${scratchRoot}`);
  }
}
