import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect } from "@playwright/test";
import { chooseMessageAction, savedTextWorkspace } from "../../../tests/ui-fixture.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-backup-test-"));
const root = path.join(scratch, "fern-data");
const archive = path.join(scratch, "My workspace.fern-backup");
const packaged = process.env.FERN_E2E_EXECUTABLE;
const previousExecutable = process.env.FERN_E2E_PREVIOUS_EXECUTABLE;
const previousSourceEntry = process.env.FERN_E2E_PREVIOUS_SOURCE_ENTRY;
assert(!(previousExecutable && previousSourceEntry), "Choose one prior Fern build.");
const testUpgrade = Boolean(previousExecutable || previousSourceEntry);
const legacyChatKey = "fern-text-threads:v1";
const savedReply = "selected color is sage";
const archivedReply = "earlier image was charcoal";
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

async function openProfile(beforeUpgrade = false) {
  const executable = beforeUpgrade ? previousExecutable : packaged;
  const sourceEntry = beforeUpgrade ? previousSourceEntry : path.join(repo, "apps/desktop/out/main/index.js");
  app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [...(executable ? [] : [path.resolve(sourceEntry)]),
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
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), Boolean(executable));
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

async function search(page, phrase, { found, open = false, savedVersion = false }) {
  await page.getByRole("button", { name: "Search threads", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search threads", exact: true });
  const input = dialog.getByRole("searchbox", { name: "Find a thread", exact: true });
  await input.fill(phrase);
  if (found) {
    const result = dialog.getByRole("button").filter({ hasText: "Portable workshop" });
    await expect(result).toContainText(phrase);
    if (savedVersion) await expect(result).toContainText("Saved version");
  } else {
    await expect(dialog.getByRole("status").filter({ hasText: "No matching threads" })).toBeVisible();
  }

  if (open) {
    await input.press("Enter");
    const find = page.getByRole("searchbox", { name: "Search this chat", exact: true });
    await expect(find).toHaveValue(phrase);
    await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString()))
      .toBe(phrase);
    await find.press("Escape");
    if (savedVersion) {
      await expect(input).toHaveValue(phrase);
      await expect(input).toBeFocused();
      await input.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  } else {
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
}

async function deleteSavedReply(page) {
  const reply = page.getByRole("article", { name: "Model response" }).filter({ hasText: savedReply });
  await chooseMessageAction(reply, "Delete reply");
  const confirmation = reply.getByRole("group", { name: "Confirm message deletion" });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(reply).toHaveCount(0);
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
  let page = await openProfile(testUpgrade);
  const chat = { activeId: chatId, threads: [{
    id: chatId, title: "Portable workshop", modelId: "local", draft: "Unsent chat draft",
    updatedAt: Date.now(), contextSize: 4096, systemPrompt: "Keep the answer brief",
    messages: [{ id: "prompt", role: "user", content: "Compare the colors.", image: attachment, createdAt: 10 },
      { id: "reply", role: "assistant", content: "The selected **color** is sage.", createdAt: 11 }],
    versions: [{ id: "saved-version", label: "First pass", messages: [
      { id: "old-prompt", role: "user", content: "Describe the image.", createdAt: 1 },
      { id: "old-reply", role: "assistant", content: "The earlier image was **charcoal**.", createdAt: 2 },
    ] }],
  }] };
  let usesLegacyStorage = false;
  await expect.poll(async () => {
    usesLegacyStorage = testUpgrade && await page.evaluate((key) => localStorage.getItem(key) !== null, legacyChatKey);
    return usesLegacyStorage || await savedTextWorkspace(page).then(Boolean, () => false);
  }).toBe(true);
  if (usesLegacyStorage) {
    // Seed the saved transcript before the old renderer reads and flushes its storage.
    await page.addInitScript(({ key, workspace }) => {
      localStorage.setItem(key, JSON.stringify(workspace));
    }, { key: legacyChatKey, workspace: { ...chat, threads: [{ ...chat.threads[0], draft: "" }] } });
  } else {
    await savedTextWorkspace(page, chat);
  }
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
  if (usesLegacyStorage) {
    await page.evaluate(() => window.studio.getApiBaseUrl());
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(page.getByText("The selected color is sage.", { exact: true })).toBeVisible();
    await composer.fill(chat.threads[0].draft);
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).threads[0].draft, legacyChatKey))
      .toBe(chat.threads[0].draft);
    await app.close();
    page = await openProfile();
    await expect.poll(() => savedTextWorkspace(page).then((workspace) => workspace?.activeId, () => undefined)).toBe(chatId);
    const migrated = (await savedTextWorkspace(page)).threads[0];
    assert.equal(migrated.messages[0].image, attachment);
    assert.equal(migrated.systemPrompt, "Keep the answer brief");
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), legacyChatKey), null);
    await search(page, archivedReply, { found: true, open: true, savedVersion: true });
    console.log("The prior Fern build saved a draft, and the new build migrated its chat history and saved version.");
  }
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent chat draft");
  await search(page, savedReply, { found: true, open: true });
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
  assert.equal(snapshot.chats.threads[0].versions[0].messages[1].content, "The earlier image was **charcoal**.");
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
  await deleteSavedReply(page);
  await search(page, savedReply, { found: false });
  await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
  await search(page, savedReply, { found: true });
  await deleteSavedReply(page);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads[0]?.messages.map(({ id }) => id))
    .toEqual(["prompt"]);

  if (testUpgrade) {
    await app.close();
    page = await openProfile();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(originalDraft, { timeout: 25_000 });
    await search(page, savedReply, { found: false });
    await search(page, archivedReply, { found: true, open: true, savedVersion: true });
    console.log("The upgraded Fern build found the saved version and excluded the deleted reply.");
  }

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
  await search(page, savedReply, { found: true, open: true });
  await search(page, archivedReply, { found: true, open: true, savedVersion: true });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent chat draft");

  await page.getByRole("button", { name: "Local data", exact: true }).click();
  await page.getByRole("combobox", { name: "Workspace to open", exact: true }).selectOption("original");
  page = await restartAfter(page.getByRole("button", { name: "Open Workspace", exact: true }));
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(originalDraft, { timeout: 25_000 });
  await search(page, savedReply, { found: false });
  await search(page, archivedReply, { found: true, savedVersion: true });

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
  console.log("Electron backup and restore preserved workspace data, scoped chat search and recovered from a malformed backup.");
} finally {
  await app?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
