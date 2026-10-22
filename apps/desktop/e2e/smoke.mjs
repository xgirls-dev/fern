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
let electronApp;
const pageErrors = [];
const consoleErrors = [];
let validatingRejectedRepository = false;
let succeeded = false;

try {
  await mkdir(path.join(customModelPath, "unet"), { recursive: true });
  await writeFile(modelIndexPath, JSON.stringify({ _class_name: "StableDiffusionXLPipeline" }));
  await writeFile(path.join(customModelPath, "unet", "openvino_model.xml"), '<net name="fern-e2e" version="11"><layers/><edges/></net>');
  await writeFile(path.join(customModelPath, "unet", "openvino_model.bin"), Buffer.from([0]));

  const env = {
    ...process.env,
    FERN_ROOT: repoRoot,
    INTEL_IRIS_ROOT: repoRoot,
    FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratchRoot, "custom-image-models.json"),
    FERN_TEXT_MODEL_REGISTRY: path.join(scratchRoot, "text-models.json"),
    HF_HOME: path.join(scratchRoot, "huggingface"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  electronApp = await electron.launch({
    args: [path.join(desktopRoot, "out", "main", "index.js"), `--user-data-dir=${profilePath}`, "--disable-gpu", "--disable-gpu-compositing", "--use-gl=swiftshader", "--use-angle=swiftshader", "--disable-features=Vulkan"],
    cwd: repoRoot,
    env,
    timeout: 90_000,
  });
  electronApp.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron] ${chunk}`));
  electronApp.process().on("exit", (code, signal) => console.error(`Electron exited: code=${code} signal=${signal}`));

  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (validatingRejectedRepository && text.includes("status of 400 (Bad Request)")) return;
      consoleErrors.push(text);
    }
  });

  const apiBaseUrl = await page.evaluate(() => window.studio.getApiBaseUrl());
  const apiDeadline = Date.now() + 65_000;
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
  await page.screenshot({ path: path.join(scratchRoot, "electron-create.png") });

  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("heading", { name: "Preferences" }).waitFor();
  await page.getByRole("heading", { name: "Image models" }).waitFor();

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
  await page.screenshot({ path: path.join(scratchRoot, "electron-custom-model-installed.png") });

  await page.getByRole("button", { name: "New image thread" }).click();
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
  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("heading", { name: "Image models" }).waitFor();

  // Cancel is exercised through the same native-dialog IPC boundary and must
  // leave the library unchanged without presenting an error.
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "Add local folder" }).click();
  await expect(page.getByRole("button", { name: "Add local folder" })).toBeEnabled();
  assert.equal(await modelCard.count(), 1, "Cancelling the picker must keep the linked model unchanged");
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

  console.log("Electron smoke passed: main process, real preload/API bridge, family/repository controls and validation, dialog IPC, local model add/remove, composer model selection, cancellation, and source preservation.");
  console.log(`Isolated profile: ${profilePath}`);
  succeeded = true;
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  if (succeeded) await rm(scratchRoot, { recursive: true, force: true });
  else console.error(`Electron smoke artifacts retained for debugging: ${scratchRoot}`);
}
