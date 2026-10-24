import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "fern-electron-e2e-"));
const customModelPath = path.join(scratchRoot, "fixture-sdxl-openvino");
const modelIndexPath = path.join(customModelPath, "model_index.json");
const profilePath = path.join(scratchRoot, "profile");
const packagedExecutable = process.env.FERN_E2E_EXECUTABLE;
let electronApp;
const pageErrors = [];
const consoleErrors = [];
let validatingRejectedRepository = false;
let succeeded = false;

async function captureWindow(page, targetPath) {
  if (!packagedExecutable) {
    await page.screenshot({ path: targetPath });
    return;
  }
  // Native capture keeps a packaged window hidden while waking its compositor.
  // CDP screenshots can stall when production DevTools are disabled.
  const window = await electronApp.browserWindow(page);
  const png = await window.evaluate(async (browserWindow) => {
    const image = await browserWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return image.toPNG().toString("base64");
  });
  await writeFile(targetPath, Buffer.from(png, "base64"));
}

try {
  await mkdir(path.join(customModelPath, "unet"), { recursive: true });
  await writeFile(modelIndexPath, JSON.stringify({ _class_name: "StableDiffusionXLPipeline" }));
  await writeFile(path.join(customModelPath, "unet", "openvino_model.xml"), '<net name="fern-e2e" version="11"><layers/><edges/></net>');
  await writeFile(path.join(customModelPath, "unet", "openvino_model.bin"), Buffer.from([0]));

  const env = {
    ...process.env,
    FERN_ROOT: repoRoot,
    INTEL_IRIS_ROOT: repoRoot,
    FERN_E2E_HEADLESS: "1",
    FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratchRoot, "custom-image-models.json"),
    FERN_TEXT_MODEL_REGISTRY: path.join(scratchRoot, "text-models.json"),
    HF_HOME: path.join(scratchRoot, "huggingface"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  electronApp = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [...(packagedExecutable ? [] : [path.join(desktopRoot, "out", "main", "index.js")]), `--user-data-dir=${profilePath}`, "--disable-gpu", "--disable-gpu-compositing", "--use-gl=swiftshader", "--use-angle=swiftshader", "--disable-features=Vulkan"],
    cwd: repoRoot,
    env,
    timeout: packagedExecutable ? 180_000 : 90_000,
  });
  electronApp.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron] ${chunk}`));
  electronApp.process().on("exit", (code, signal) => console.error(`Electron exited: code=${code} signal=${signal}`));

  let page = await electronApp.firstWindow();
  if (packagedExecutable) {
    const deadline = Date.now() + 180_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      for (const candidate of electronApp.windows()) {
        try {
          if (await candidate.evaluate(() => typeof window.studio?.getApiBaseUrl === "function")) { page = candidate; found = true; break; }
        } catch { /* Runtime setup windows close when the main window opens. */ }
      }
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(found, "Packaged Fern should finish runtime extraction and open its main renderer");
    assert.equal(await electronApp.evaluate(({ app }) => app.isPackaged), true, "This run must use the packaged executable");
  }
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const browserWindow = await electronApp.browserWindow(page);
  await browserWindow.evaluate((window) => window.webContents.setBackgroundThrottling(false));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (validatingRejectedRepository && text.includes("status of 400 (Bad Request)")) return;
      consoleErrors.push(text);
    }
  });

  const apiBaseUrl = await page.evaluate(() => window.studio.getApiBaseUrl());
  const apiDeadline = Date.now() + (packagedExecutable ? 180_000 : 65_000);
  let healthStatus = 0;
  let lastHealthError = "";
  while (Date.now() < apiDeadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`);
      healthStatus = response.status;
      if (response.ok) break;
      lastHealthError = `HTTP ${response.status}`;
    } catch (error) {
      lastHealthError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const bridge = await page.evaluate(async () => ({
    url: await window.studio.getApiBaseUrl(),
    isolated: typeof window.studio === "object" && typeof process === "undefined" && typeof require === "undefined",
  }));
  assert.equal(bridge.url, apiBaseUrl, "The preload bridge should keep the assigned API URL");
  assert.equal(healthStatus, 200, `Fern backend should become healthy (${lastHealthError})`);
  assert.ok(bridge.isolated, "Renderer should expose only the context-isolated preload bridge");
  assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, "Electron smoke must keep its isolated window hidden");
  await captureWindow(page, path.join(scratchRoot, "electron-create.png"));
  const referencePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("Reference image file").setInputFiles([{ name: "reference-one.png", mimeType: "image/png", buffer: referencePng }, { name: "reference-two.png", mimeType: "image/png", buffer: referencePng }]);
  await expect(page.locator(".composer-reference")).toHaveCount(2);
  for (let reload = 0; reload < 3; reload += 1) {
    await page.reload();
    await expect(page.locator(".composer-reference")).toHaveCount(2);
  }
  await page.getByRole("button", { name: "Remove reference 2", exact: true }).click();
  await page.getByRole("button", { name: "Remove reference 1", exact: true }).click();

  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Image models" }).waitFor();
  const modelsWidth = await page.locator(".models-view").evaluate((view) => ({ page: view.getBoundingClientRect().width, main: view.closest("main").getBoundingClientRect().width }));
  assert(Math.abs(modelsWidth.page - modelsWidth.main) <= 2, "Model management must fill the main window content area");
  await page.getByText("Add custom model", { exact: true }).click();

  const familyPicker = page.getByRole("combobox", { name: "Custom image model family" });
  await expect(familyPicker).toHaveValue("sdxl");
  await expect(familyPicker.locator("option")).toHaveCount(6);
  await familyPicker.selectOption("flux2-klein");
  await familyPicker.selectOption("sdxl");
  const repoInput = page.getByRole("textbox", { name: "Hugging Face repository" });
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
  await repoInput.fill("https://example.com/owner/model");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  const rejectedRepoResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/models/custom/download") && response.request().method() === "POST",
  );
  validatingRejectedRepository = true;
  await page.getByRole("button", { name: "Download", exact: true }).click();
  assert.equal((await rejectedRepoResponse).status(), 400, "An untrusted Hugging Face host must be rejected by the API");
  await page.getByRole("alert").getByText("Paste a Hugging Face model URL or enter owner/model.").waitFor();
  validatingRejectedRepository = false;
  await repoInput.fill("");

  // Playwright patches Electron's real dialog API in the main process. This
  // drives Fern's actual preload IPC and renderer flow without OS-level UI.
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, customModelPath);
  await page.getByRole("button", { name: "Add local folder" }).click();

  const modelCard = page.locator("article.model-library-card").filter({ has: page.getByRole("heading", { name: path.basename(customModelPath) }) });
  await modelCard.waitFor({ state: "visible", timeout: 30_000 });
  await modelCard.getByText("Installed · local OpenVINO export linked").waitFor();
  await modelCard.scrollIntoViewIfNeeded();
  await captureWindow(page, path.join(scratchRoot, "electron-custom-model-installed.png"));
  await mkdir(path.join(repoRoot, "artifacts", "ux-verification"), { recursive: true });
  await captureWindow(page, path.join(repoRoot, "artifacts", "ux-verification", "electron-models.png"));

  await page.locator(".sidebar-new-menu > button").click();
  await page.getByRole("menuitem", { name: "New image thread" }).click();
  const modelTrigger = page.getByRole("button", { name: "Image model: Klein 9B" });
  await modelTrigger.waitFor();
  await modelTrigger.click();
  const customChoice = page.getByRole("menuitemradio", { name: path.basename(customModelPath) });
  await customChoice.waitFor();
  await customChoice.click();
  await expect(page.getByRole("button", { name: `Image model: ${path.basename(customModelPath)}` })).toBeVisible();
  const selectedImageThreadId = await page.locator('.sidebar-thread-button[aria-current="page"]').getAttribute("data-thread-id");
  assert.ok(selectedImageThreadId, "The custom model selection should belong to an active image thread");
  await page.getByRole("button", { name: "Image settings" }).last().click();
  await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("1024");
  await expect(page.getByRole("spinbutton", { name: "Height", exact: true })).toHaveValue("1024");
  await expect(page.getByLabel("Step count")).toHaveValue("30");
  await expect(page.getByLabel("Guidance value")).toHaveValue("7");
  await expect(page.locator("#width")).toHaveAttribute("min", "512");
  await expect(page.locator("#width")).toHaveAttribute("max", "1536");
  await expect(page.locator("#width")).toHaveAttribute("step", "8");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("heading", { name: "Image models" }).waitFor();
  await page.getByText("Add custom model", { exact: true }).click();
  await expect(modelCard).toBeVisible();

  // Cancel is exercised through the same native-dialog IPC boundary and must
  // leave the library unchanged without presenting an error.
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "Add local folder" }).click();
  await expect(page.getByRole("button", { name: "Add local folder" })).toBeEnabled();
  await expect(modelCard).toHaveCount(1);
  assert.equal(await page.getByRole("alert").count(), 0, "Cancelling the picker should not show an error");

  await modelCard.getByRole("button", { name: "Remove" }).click();
  await modelCard.getByRole("button", { name: "Confirm removal" }).click();
  await modelCard.waitFor({ state: "detached", timeout: 30_000 });
  assert.ok((await readFile(modelIndexPath)).length > 0, "Removing a local link must preserve the source model files");
  // Return to the thread that selected this model. A new thread correctly
  // starts without a model selection on a clean CI runner.
  await page.locator(`.sidebar-thread-button[data-thread-id="${selectedImageThreadId}"]`).click();
  await expect(page.getByRole("button", { name: "Image model: Custom model · Missing" })).toBeVisible();
  assert.deepEqual(pageErrors, [], `Renderer errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(" | ")}`);

  console.log("Electron smoke passed: hidden main window, real preload/API bridge, multi-reference persistence, Models navigation, family/repository controls, dialog IPC, local model add/remove, composer model selection, cancellation, and source preservation.");
  console.log(`Isolated profile: ${profilePath}`);
  succeeded = true;
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  if (succeeded) await rm(scratchRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  else console.error(`Electron smoke artifacts retained for debugging: ${scratchRoot}`);
}
