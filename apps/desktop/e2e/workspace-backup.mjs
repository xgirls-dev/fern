import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect } from "@playwright/test";
import { savedTextWorkspace } from "../../../tests/ui-fixture.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-backup-test-"));
const root = path.join(scratch, "fern-data");
const archive = path.join(scratch, "My workspace.fern-backup");
const packaged = process.env.FERN_E2E_EXECUTABLE;
const chatId = "text-thread-portable";
const imageId = "thread-portable-image";
const audioId = "audio-thread-portable";
const attachment = "chat-image-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVlgAAAAASUVORK5CYII=", "base64");
const reference = { dataUrl: `data:image/png;base64,${png.toString("base64")}`, label: "Reference to keep" };
const assets = {
  "outputs/poster.png": png,
  "outputs/take.wav": Buffer.from("audio file"),
  "outputs/clip.webm": Buffer.from("video file"),
  [`data/references/${attachment}`]: png,
  "data/chat-documents/example.json": Buffer.from('{"text":"A saved document"}'),
  "data/videos/1760000000000-12345678.json": Buffer.from('{"name":"clip.webm"}'),
  "data/flux2_gallery.json": Buffer.from('{"poster.png":{"threadId":"text-thread-portable"}}'),
};
const errors = [];
const profile = path.join(scratch, "profile");
const env = { ...process.env, FERN_ROOT: root, INTEL_IRIS_ROOT: root, FERN_E2E_HEADLESS: "1",
  FERN_TEXT_MODEL_REGISTRY: path.join(scratch, "text-models.json"),
  FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratch, "custom-image-models.json") };
delete env.ELECTRON_RUN_AS_NODE;
let app;

async function openProfile() {
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(repo, "apps/desktop/out/main/index.js")]),
      `--user-data-dir=${profile}`, "--disable-gpu"],
    env, cwd: repo, timeout: 180_000,
  });
  let page;
  await expect.poll(async () => {
    for (const candidate of app.windows()) {
      if (await candidate.evaluate(() => typeof window.studio?.getApiBaseUrl === "function").catch(() => false)) {
        page = candidate;
        return true;
      }
    }
    return false;
  }, { timeout: 180_000 }).toBe(true);
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), Boolean(packaged));
  page.on("pageerror", (error) => errors.push(error.message));
  await (await app.browserWindow(page)).evaluate((window) => window.webContents.setBackgroundThrottling(false));
  // Launch each process under Playwright, preserving the native startup and profile handoff.
  await app.evaluate(({ app }) => { app.relaunch = () => {}; });
  return page;
}

async function restartAfter(button) {
  const exited = once(app.process(), "exit", { signal: AbortSignal.timeout(30_000) });
  try {
    await button.click({ noWaitAfter: true });
  } catch (error) {
    if (!/Target page, context or browser has been closed/.test(String(error))) throw error;
  }
  const [code, signal] = await exited;
  assert.equal(code, 0, `Fern should quit cleanly during workspace switch (${signal ?? "no signal"})`);
  return openProfile();
}

async function openRestore(page, file) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, file);
  await page.getByRole("button", { name: "Local data", exact: true }).click();
  await page.getByRole("button", { name: "Restore Backup…", exact: true }).click();
  return page.getByRole("dialog", { name: "Restore workspace", exact: true });
}
try {
  for (const [name, content] of Object.entries(assets)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(path.join(root, "models"), { recursive: true });
  await writeFile(path.join(root, "models", "not-in-the-backup.gguf"), "model fixture");
  let page = await openProfile();
  await expect.poll(() => savedTextWorkspace(page).then(Boolean, () => false)).toBe(true);
  await savedTextWorkspace(page, { activeId: chatId, threads: [{
    id: chatId, title: "Portable workshop", modelId: "local", draft: "Unsent chat draft",
    updatedAt: Date.now(), contextSize: 4096, systemPrompt: "Keep the answer brief",
    messages: [{ id: "prompt", role: "user", content: "Compare the colors.", image: attachment, createdAt: 10 },
      { id: "reply", role: "assistant", content: "The selected color is sage.", createdAt: 11 }],
    versions: [{ id: "saved-version", label: "First pass", messages: [
      { id: "old-prompt", role: "user", content: "Describe the image.", createdAt: 1 },
      { id: "old-reply", role: "assistant", content: "The earlier image was charcoal.", createdAt: 2 },
    ] }],
  }] });
  await page.evaluate(async ({ imageId, audioId, reference }) => {
    localStorage.setItem("fern-last-workspace:v1", "text");
    localStorage.setItem("fern-sidebar-collapsed", "false");
    localStorage.setItem("fern-studio-settings:v3", JSON.stringify({ theme: "dark", model: "4b" }));
    localStorage.setItem("fern-threads:v1", JSON.stringify({ activeId: imageId, threads: [{
      id: imageId, title: "Image workshop", settings: { prompt: "Unsent image draft", model: "4b" },
      imageNames: ["poster.png"], updatedAt: 20, previewName: "poster.png",
    }] }));
    localStorage.setItem("fern-qwen3-tts-threads:v1", JSON.stringify({ activeId: audioId, threads: [{
      id: audioId, title: "Speech workshop", text: "Unsent speech draft", outputs: [], updatedAt: 30,
    }] }));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("fern-thread-references", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("images");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("images", "readwrite");
        transaction.objectStore("images").put([reference], imageId);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { imageId, audioId, reference });

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent chat draft");
  await page.getByRole("button", { name: "Local data", exact: true }).click();
  const backup = page.getByRole("button", { name: "Save Backup…", exact: true });
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await backup.click();
  await expect(backup).toBeEnabled();
  await assert.rejects(readFile(archive), { code: "ENOENT" });
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, archive);
  await backup.click();
  await expect(page.getByText("Workspace backup saved.", { exact: true })).toBeVisible({ timeout: 30_000 });

  const stage = path.join(scratch, "restored-files");
  const python = process.env.FERN_E2E_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  await promisify(execFile)(python, [path.join(repo, "scripts/workspace_backup.py"), "stage", archive, stage]);
  const snapshot = JSON.parse(await readFile(path.join(stage, "workspace.json"), "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.chats.activeId, chatId);
  assert.equal(snapshot.chats.threads[0].draft, "Unsent chat draft");
  assert.equal(snapshot.chats.threads[0].messages[0].image, attachment);
  assert.equal(snapshot.chats.threads[0].versions[0].messages[1].content, "The earlier image was charcoal.");
  assert.equal(snapshot.chats.threads[0].systemPrompt, "Keep the answer brief");
  assert.equal(snapshot.images.threads[0].settings.prompt, "Unsent image draft");
  assert.deepEqual(snapshot.imageReferences[imageId], [reference]);
  assert.equal(snapshot.speech.threads[0].text, "Unsent speech draft");
  assert.equal(snapshot.settings.theme, "dark");
  assert.equal(snapshot.preferences["fern-sidebar-collapsed"], "false");
  for (const [name, content] of Object.entries(assets)) {
    assert.deepEqual(await readFile(path.join(stage, name)), content);
  }
  await assert.rejects(readFile(path.join(stage, "models", "not-in-the-backup.gguf")), { code: "ENOENT" });
  const originalDraft = "This draft was edited after saving the backup";
  await page.getByRole("button", { name: "Text thread: Portable workshop", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(originalDraft);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads[0]?.draft).toBe(originalDraft);

  let restore = await openRestore(page, archive);
  await expect(restore).toContainText("My workspace");
  await restore.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(restore).toHaveCount(0);
  await page.getByRole("button", { name: "Restore Backup…", exact: true }).click();
  restore = page.getByRole("dialog", { name: "Restore workspace", exact: true });
  page = await restartAfter(restore.getByRole("button", { name: "Restore and Restart", exact: true }));

  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent chat draft", { timeout: 25_000 });
  const recovered = await savedTextWorkspace(page);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.threads[0].versions)), snapshot.chats.threads[0].versions);
  assert.equal(recovered.threads[0].systemPrompt, "Keep the answer brief");
  assert.equal(recovered.threads[0].messages[0].image, attachment);
  const api = await page.evaluate(() => window.studio.getApiBaseUrl());
  const image = await fetch(`${api}/references/${attachment}`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const recoveredState = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem("fern-studio-settings:v3")),
    image: JSON.parse(localStorage.getItem("fern-threads:v1")).threads[0],
    speech: JSON.parse(localStorage.getItem("fern-qwen3-tts-threads:v1")).threads[0],
  }));
  assert.equal(recoveredState.settings.theme, "dark");
  assert.equal(recoveredState.image.settings.prompt, "Unsent image draft");
  assert.equal(recoveredState.speech.text, "Unsent speech draft");
  const restoredReferences = await page.evaluate((id) => new Promise((resolve, reject) => {
    const request = indexedDB.open("fern-thread-references", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("images", "readonly");
      const stored = transaction.objectStore("images").get(id);
      transaction.oncomplete = () => { db.close(); resolve(stored.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), imageId);
  assert.deepEqual(restoredReferences, [reference]);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent chat draft");


  await page.getByRole("button", { name: "Local data", exact: true }).click();
  await page.getByRole("combobox", { name: "Workspace to open", exact: true }).selectOption("original");
  page = await restartAfter(page.getByRole("button", { name: "Open Workspace", exact: true }));
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(originalDraft, { timeout: 25_000 });

  const malformedState = path.join(scratch, "malformed.json");
  const malformedArchive = path.join(scratch, "Malformed.fern-backup");
  await writeFile(malformedState, '{"version":1,"chats":[]}');
  await promisify(execFile)(python, [path.join(repo, "scripts/workspace_backup.py"), "create", root, malformedState, malformedArchive]);
  restore = await openRestore(page, malformedArchive);
  page = await restartAfter(restore.getByRole("button", { name: "Restore and Restart", exact: true }));
  await expect(page.getByRole("alert")).toContainText("Your previous workspace is still available.");
  page = await restartAfter(page.getByRole("button", { name: "Return to previous workspace", exact: true }));
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(originalDraft, { timeout: 25_000 });
  for (const [name, content] of Object.entries(assets)) assert.deepEqual(await readFile(path.join(root, name)), content);
  assert.deepEqual(errors, []);
  console.log("Electron backup and restore preserved workspace data and returned to the original after a malformed restore.");
} finally {
  await app?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
