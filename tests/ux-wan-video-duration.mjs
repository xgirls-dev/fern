import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseSelectOption } from "./select-option.mjs";
import { fixture } from "./ui-fixture.mjs";

const { page, errors, close } = await fixture({ firstRun: true, viewport: { width: 800, height: 740 } });
const model = { runtimeReady: true, runtimeNote: "Vulkan · Intel GPU", platformSupported: true,
  videoFormat: { width: 544, height: 704, fps: 16, defaultFrames: 21, frameOptions: [21, 65, 81, 97, 113, 129, 145, 161] } };
let job = { id: null, status: "idle", phase: null, output: null, error: null };
const idle = job;
const requested = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+uR1ZVwAAAABJRU5ErkJggg==", "base64");

try {
  await page.route("**/api/video/status*", (route) => route.fulfill({ json: { job, model, clips: [] } }));
  await page.route("**/api/video/generate", (route) => {
    requested.push(route.request().postDataJSON().frames);
    job = { ...idle, id: "clip", status: "running", phase: "Generating frames on Intel GPU…" };
    return route.fulfill({ status: 202, json: { job } });
  });
  await page.route("**/api/video/stop", (route) => {
    job = { ...job, status: "cancelled", phase: null };
    return route.fulfill({ status: 202, json: { job } });
  });

  await page.getByRole("button", { name: "Video", exact: true }).click();
  const duration = page.getByRole("combobox", { name: "Duration" });
  await expect(duration).toHaveText("1.31 s");
  await chooseSelectOption(duration, "10 s");
  await expect(duration).toHaveText("10 s");
  await expect(page.getByText(/Longer clips take more time/)).toBeVisible();
  await page.locator('input[type="file"][aria-label="Choose first frame"]').setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
  await page.getByLabel("Motion prompt").fill("A fox turns.");
  await page.getByRole("button", { name: "Generate video" }).click();
  await expect.poll(() => requested).toEqual([161]);
  await expect(duration).toBeDisabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Generation stopped.")).toBeVisible();
  await expect(duration).toBeEnabled();
  await expect(duration).toHaveText("10 s");
  await chooseSelectOption(duration, "4 s");
  await page.getByRole("button", { name: "Generate video" }).click();
  await expect.poll(() => requested).toEqual([161, 65]);
  assert.deepEqual(errors, []);
} finally {
  await close();
}
