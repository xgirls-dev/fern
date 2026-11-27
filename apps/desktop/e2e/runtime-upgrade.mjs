import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect } from "@playwright/test";
import { savedTextWorkspace } from "../../../tests/ui-fixture.mjs";

const [installerApp, mode] = process.argv.slice(2);
assert(process.platform === "win32" && path.isAbsolute(installerApp));
assert(["baseline", "candidate"].includes(mode));
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-runtime-upgrade-"));
const executable = path.join(scratch, "app", path.basename(installerApp));
const resources = path.join(scratch, "app", "resources");
const bundledArchive = path.join(resources, "runtime-release.zip");
const missingArchive = `${bundledArchive}.held`;
const profile = path.join(scratch, "profile");
const workspace = path.join(scratch, "workspace");
const target = path.join(profile, "runtime");
const previous = path.join(profile, "runtime-previous");
const stage = path.join(profile, "runtime-installing");
const marker = (directory) => path.join(directory, ".installed");
const args = [`--user-data-dir=${profile}`, "--fern-software-rendering", "--enable-logging=stderr"];
const env = { ...process.env, FERN_ROOT: workspace, FERN_E2E_HEADLESS: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const execFile = promisify(execFileCallback);
const draft = "Keep this chat draft through runtime setup.";
const localFile = path.join(workspace, "models", "recovery-fixture.txt");
let app;

async function openChat() {
  app = await electron.launch({ executablePath: executable, args, env, timeout: 180_000 });
  assert(await app.evaluate(({ app }) => app.isPackaged));
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
  await page.evaluate(() => window.studio.getApiBaseUrl());
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return { page, composer };
}

async function failSetup() {
  const { stdout, stderr } = await execFile(executable, args, { env, windowsHide: true, timeout: 45_000 });
  assert.match(stdout + stderr, /The bundled AI runtime archive is missing/);
}

try {
  await cp(path.dirname(installerApp), path.dirname(executable), { recursive: true });
  const manifest = JSON.parse((await readFile(path.join(resources, "runtime-release.json"), "utf8")).replace(/^\uFEFF/, ""));
  const revision = `${manifest.archiveSha256}\n`;
  const older = `${manifest.archiveSha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64)}\n`;
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(localFile, "A local file that runtime setup must preserve.");
  const { page, composer } = await openChat();
  await composer.fill(draft);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads.some((thread) => thread.draft === draft)).toBe(true);
  await app.close();
  app = null;
  assert.equal(await readFile(marker(target), "utf8"), revision);

  // Model an interruption after the old runtime has been moved and before the stage is installed.
  await rename(target, previous);
  await writeFile(marker(previous), older);
  await mkdir(stage);
  await writeFile(path.join(stage, "partial"), "incomplete extraction");
  await rename(bundledArchive, missingArchive);
  try {
    await failSetup();
    const survivingRuntime = mode === "candidate" ? target : previous;
    assert.equal(await readFile(marker(survivingRuntime), "utf8"), older);
    await assert.rejects(readFile(marker(mode === "candidate" ? previous : target)), { code: "ENOENT" });
    await rm(stage, { recursive: true });

    // Use the complete runtime from the first launch as the finished stage.
    await rename(survivingRuntime, stage);
    await writeFile(marker(stage), revision);
    if (mode === "baseline") {
      await failSetup();
      assert.equal(await readFile(marker(stage), "utf8"), revision);
      console.log("Baseline reproduced: the old runtime stayed parked and setup could not resume a complete stage.");
    } else {
      const reopened = await openChat();
      await expect(reopened.composer).toHaveValue(draft);
      assert.equal(await readFile(marker(target), "utf8"), revision);
      await assert.rejects(readFile(marker(stage)), { code: "ENOENT" });
      console.log("Runtime upgrade recovered the prior runtime on failure and then opened the saved draft from a complete stage.");
    }
    assert.equal(await readFile(localFile, "utf8"), "A local file that runtime setup must preserve.");
  } finally {
    await rename(missingArchive, bundledArchive);
  }
} finally {
  await app?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
