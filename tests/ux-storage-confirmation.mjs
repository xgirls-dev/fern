import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, errors, close } = await fixture();
let deletions = 0;
const storage = {
  cache: { bytes: 100, fileCount: 1, retentionDays: 30, maxBytes: 1000 },
  outputs: { bytes: 100, fileCount: 1 },
  images: { bytes: 100, fileCount: 1 },
  audio: { bytes: 0, fileCount: 0 },
  metadata: { bytes: 10 },
  models: { bytes: 1000, preservedOnReset: true },
  disk: { freeBytes: 10000, totalBytes: 20000, reserveBytes: 2000 },
  managedBytes: 1210,
};

try {
  await page.route("**/api/storage/status", (route) => route.fulfill({ json: storage }));
  await page.route("**/api/storage/clear-local-data", (route) => {
    deletions += 1;
    return route.fulfill({ json: { storage } });
  });
  await page.getByRole("button", { name: "Local data", exact: true }).click();
  const trigger = page.getByRole("button", { name: "Clear Local Data", exact: true });
  await page.evaluate(() => {
    window.studio.saveWorkspaceBackup = (snapshot) => new Promise((resolve) => {
      window.backupSnapshot = JSON.parse(snapshot);
      window.finishBackup = resolve;
    });
  });
  const backup = page.getByRole("button", { name: "Save Backup…", exact: true });
  await backup.click();
  await expect(page.getByRole("status").filter({ hasText: "Saving workspace backup…" })).toBeVisible();
  await expect(backup).toBeDisabled();
  await expect(trigger).toBeDisabled();
  assert.equal(await page.evaluate(() => window.backupSnapshot.version), 1);
  await page.evaluate(() => window.finishBackup(true));
  await expect(page.getByText("Workspace backup saved.", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    window.studio.chooseWorkspaceBackup = async () => ({
      token: "backup", name: "My workspace", createdAt: "2026-11-24T00:00:00Z", fileCount: 4, size: 2000,
    });
    window.studio.restoreWorkspaceBackup = async () => { throw new Error("Restore requires explicit confirmation"); };
  });
  await page.getByRole("button", { name: "Restore Backup…", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "Restore workspace", exact: true });
  await expect(restore).toContainText("My workspace");
  await expect(restore.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(restore).toHaveCount(0);


  await trigger.scrollIntoViewIfNeeded();
  const before = await trigger.boundingBox();
  assert(before);
  await trigger.click();
  const confirmation = page.getByRole("group", { name: "Delete local data?" });
  await confirmation.waitFor({ state: "visible" });
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  assert(await cancel.evaluate((element) => document.activeElement === element));
  const finalButton = await confirmation.getByRole("button", { name: "Delete local data", exact: true }).boundingBox();
  assert(finalButton);
  const initialCenter = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  assert(!(initialCenter.x >= finalButton.x && initialCenter.x <= finalButton.x + finalButton.width && initialCenter.y >= finalButton.y && initialCenter.y <= finalButton.y + finalButton.height));
  await page.mouse.click(initialCenter.x, initialCenter.y);
  assert.equal(deletions, 0);
  await page.keyboard.press("Escape");
  assert.equal(await confirmation.count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Clear Local Data");
  assert(await trigger.evaluate((element) => document.activeElement === element));
  assert.deepEqual(errors, []);
} finally {
  await close();
}
