import assert from "node:assert/strict";
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
