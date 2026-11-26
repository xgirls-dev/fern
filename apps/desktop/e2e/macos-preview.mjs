import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { verifyChatHistory } from "./chat-history.mjs";
import { verifyChatComposer } from "./chat-composer.mjs";

const executablePath = process.env.FERN_E2E_EXECUTABLE;
assert(executablePath, "Set FERN_E2E_EXECUTABLE to the Fern.app executable.");
assert.equal(process.arch, "arm64");
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-macos-preview-"));
let app;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(scratch, "profile")}`],
    env: { ...process.env, FERN_ROOT: path.join(scratch, "data"), FERN_E2E_HEADLESS: "1" },
    timeout: 90_000,
  });
  app.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const page = await app.firstWindow();
  assert(await app.evaluate(({ app }) => app.isPackaged));
  const base = await page.evaluate(() => window.studio.getApiBaseUrl());
  await expect.poll(async () => {
    const response = await fetch(base + "/api/health").catch(() => null);
    return response?.status;
  }, { timeout: 60_000 }).toBe(200);

  const text = await (await fetch(base + "/api/text/status")).json();
  assert.equal(text.ggufAvailable, true);
  assert.equal(text.defaultModelId, "gemma-4-e4b-gguf");
  const recommended = new Map(text.recommendedModels.map((model) => [model.id, model]));
  assert.equal(recommended.get(text.defaultModelId)?.format, "gguf");
  assert.deepEqual(recommended.get("qwen2.5-0.5b-instruct-gguf")?.recommendedDevices, ["CPU"]);
  assert(text.recommendedModels.every((model) => model.format === "gguf"));
  const { models } = await (await fetch(base + "/api/models")).json();
  assert.deepEqual(models.map((model) => model.id), ["klein-4b-mlx"]);

  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const klein = page.getByRole("heading", { name: "Klein 4B · MLX", exact: true });
  await expect(klein).toBeVisible();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByText("Gemma 4 E4B · GGUF", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qwen2.5 0.5B Instruct", exact: true })).toBeVisible();
  await (await app.browserWindow(page)).evaluate((window) => window.webContents.setBackgroundThrottling(false));
  await verifyChatHistory(page);
  await verifyChatComposer(page);
  console.log("Packaged arm64 app started its bundled Python backend and displayed the Mac model catalog.");
  console.log(models[0].setupUnavailableReason ?? "Metal detected. Model inference requires a separate real-model test.");
} finally {
  if (app) await app.close();
  await rm(scratch, { recursive: true, force: true });
}
