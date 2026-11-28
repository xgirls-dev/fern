import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, errors, dir, close } = await fixture();
const frame = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8lhkAAAAASUVORK5CYII=",
  "base64",
);
const clip = {
  id: "1760000000000-aabb1234",
  name: "wan-1760000000000-aabb1234.webm",
  url: "/outputs/example.webm",
  posterUrl: "/references/video-frame.png",
  prompt: "The fox turns toward the camera.",
  seed: 42,
  width: 544,
  height: 704,
  duration: 1.3125,
  generationTime: 25.41,
  modelLabel: "Wan 2.2 Turbo",
};
const idle = { id: null, status: "idle", phase: null, output: null, error: null };
let job = idle;
let clips = [];
let installed = false;
let generated;
let generationCount = 0;
let exported;
let fullRecoveryReads = 0;
let expectRecovery = false;
let restartCount = 0;
let lateStop;
let holdStop = false;
const outageMessage = "Fern’s local service stopped unexpectedly.";
await page.route("**/references/video-frame.png", (route) => route.fulfill({ body: frame, contentType: "image/png" }));
await page.route("**/fixture/export-video", async (route) => {
  exported = route.request().postData();
  await route.fulfill({ json: {} });
});
if (process.env.FERN_TEST_WEBM) {
  const body = await readFile(process.env.FERN_TEST_WEBM);
  await page.route("**/outputs/example.webm", (route) => route.fulfill({ body, contentType: "video/webm" }));
} else {
  await page.route("**/outputs/example.webm", (route) => route.fulfill({ status: 204 }));
}
await page.route("**/api/video/status*", (route) => {
  const jobOnly = new URL(route.request().url()).searchParams.has("job");
  if (expectRecovery && !jobOnly) {
    fullRecoveryReads++;
    expectRecovery = false;
  }
  return route.fulfill({
    json: { job, clips: jobOnly ? null : clips,
      model: { runtimeReady: installed, platformSupported: true, runtimeNote: "Install Wan 2.2 Turbo in Models before generating." } },
  });
});
await page.route("**/fixture/backend-retry", (route) => {
  restartCount++;
  expectRecovery = true;
  job = idle;
  return route.fulfill({ json: { ok: true } });
});
await page.route("**/api/video/generate", (route) => {
  generated = route.request().postDataJSON();
  const id = ["1760000000000-aabb1232", "1760000000000-aabb1233", clip.id][generationCount++];
  job = { ...idle, id, status: "running", phase: "Generating frames on Intel GPU…",
    logs: ["Preparing video…", "Loading Wan 2.2 on Intel GPU…", "Generating frames on Intel GPU…"] };
  return route.fulfill({ status: 202, json: { job } });
});
await page.route("**/api/video/stop", async (route) => {
  if (holdStop) {
    lateStop = route;
    return;
  }
  job = { ...job, status: "cancelled", phase: null, logs: [...job.logs, "Stopping…", "Generation stopped."] };
  return route.fulfill({ status: 202, json: { job } });
});
await page.route("**/api/video/remove", (route) => {
  assert.equal(route.request().postDataJSON().id, clip.id);
  clips = [];
  job = idle;
  return route.fulfill({ json: { clips, job } });
});

try {
  await page.reload();
  await page.evaluate(() => {
    window.studio.saveOutputVideo = async (name) => {
      await fetch("/fixture/export-video", { method: "POST", body: name });
      return "export.webm";
    };
  });
  await page.getByRole("button", { name: "Video", exact: true }).click();
  const heading = page.getByRole("heading", { name: "Video", exact: true });
  await heading.waitFor();
  assert(await heading.evaluate((element) => element === document.activeElement));
  await page.getByRole("button", { name: "Open video models" }).click();
  await page.getByRole("heading", { name: "Video models" }).waitFor();
  installed = true;
  const navigation = page.getByRole("navigation", { name: "Studio" });
  await navigation.getByRole("button", { name: "Video", exact: true }).click();
  const begin = page.getByRole("button", { name: "Generate video" });
  const actions = page.locator(".video-actions");
  const terminal = page.getByRole("region", { name: "Activity terminal" });
  const toggleActivity = terminal.getByRole("button", { name: /^Activity/ });
  const scrollback = terminal.getByRole("region", { name: "Video activity scrollback" });
  await begin.waitFor();
  assert(await begin.isDisabled());
  await page.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: frame });
  await page.getByRole("textbox", { name: "Motion prompt" }).fill(clip.prompt);
  await begin.click();
  await actions.getByText("Generating frames on Intel GPU…").waitFor();
  assert.equal(generated.prompt, clip.prompt);
  assert.equal(generated.seed, 42);
  assert(generated.referenceImage.startsWith("data:image/png;base64,"));
  await toggleActivity.click();
  await expect(scrollback).toContainText("Loading Wan 2.2 on Intel GPU…");
  await navigation.getByRole("button", { name: "Models", exact: true }).click();
  job = { ...job, phase: "Decoding the clip…", logs: [...job.logs, "Decoding the clip…"] };
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fern-video-activity"))).toContain("Decoding the clip…");
  await navigation.getByRole("button", { name: "Video", exact: true }).click();
  await expect(scrollback).toContainText("Decoding the clip…");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(actions.getByText("Generation stopped.")).toBeVisible();
  await expect(scrollback).toContainText("Generation stopped.");
  const restart = page.getByRole("button", { name: "Restart local service", exact: true });
  const motion = page.getByRole("textbox", { name: "Motion prompt" });
  const reportServiceExit = () => page.evaluate((message) => {
    window.dispatchEvent(new CustomEvent("fern-fixture-backend-error", { detail: { message, stage: "running" } }));
  }, outageMessage);

  await begin.click();
  await actions.getByText("Generating frames on Intel GPU…").waitFor();
  holdStop = true;
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => Boolean(lateStop)).toBe(true);
  await reportServiceExit();
  await expect(page.getByRole("alert").filter({ hasText: outageMessage })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect(actions.getByText("Generating frames on Intel GPU…")).toHaveCount(0);
  await expect(terminal.locator(".activity-terminal-live")).toHaveCount(0);
  await restart.focus();
  await restart.press("Enter");
  await expect(heading).toBeFocused();
  await expect(begin).toBeEnabled();
  await expect(motion).toHaveValue(clip.prompt);
  await expect(page.getByRole("img", { name: "First frame cropped to the output dimensions" })).toBeVisible();
  await expect(page.getByText("Video generation was interrupted. Generate again to retry this clip.")).toBeVisible();
  assert.equal(fullRecoveryReads, 1);
  await lateStop.fulfill({ json: { job: { ...idle, id: clip.id, status: "stopping", phase: "Stopping…" } } });
  await expect(begin).toBeEnabled();
  expectRecovery = false;
  holdStop = false;

  await begin.click();
  await actions.getByText("Generating frames on Intel GPU…").waitFor();
  await reportServiceExit();
  await expect(restart).toBeVisible();
  clips = [clip];
  await restart.click();
  await expect(begin).toBeEnabled();
  await expect(page.getByText("Video generation was interrupted.", { exact: false })).toHaveCount(0);
  assert.equal(restartCount, 2);
  assert.equal(fullRecoveryReads, 2);
  await page.getByRole("button", { name: "Save WebM" }).waitFor();
  if (process.env.FERN_TEST_WEBM) {
    const actual = await page.locator("video").evaluate(async (element) => {
      await element.play();
      return { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
    });
    assert.equal(actual.width, clip.width);
    assert.equal(actual.height, clip.height);
    assert(Math.abs(actual.duration - clip.duration) < 0.08);
  }
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/fixture/export-video")),
    page.getByRole("button", { name: "Save WebM" }).click(),
  ]);
  assert.equal(exported, clip.name);
  const form = await page.locator(".video-form").boundingBox();
  const preview = await page.locator(".video-preview").boundingBox();
  assert(form.width >= 280 && preview.width >= 320 && preview.x > form.x + form.width);
  await page.screenshot({ path: `${dir}/video-preview.png` });
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const firstFrame = page.getByRole("button", { name: "Replace first frame" });
  const fieldFill = await firstFrame.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.keyboard.press("Tab");
  await firstFrame.focus();
  await expect(firstFrame).toHaveCSS("outline-style", "none");
  await expect(firstFrame).not.toHaveCSS("background-color", fieldFill);
  await page.screenshot({ path: `${dir}/video-activity-dark.png` });
  const resizeActivity = terminal.getByRole("separator", { name: "Resize activity terminal" });
  await resizeActivity.press("ArrowUp");
  await expect(resizeActivity).toHaveAttribute("aria-valuenow", "192");
  await page.setViewportSize({ width: 740, height: 800 });
  const workspace = page.locator(".video-workspace");
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  await page.reload();
  await page.getByRole("button", { name: "Save WebM" }).waitFor();
  await expect(scrollback).toContainText("Generation stopped.");
  await expect(scrollback).toContainText("Decoding the clip…");
  await expect(scrollback.locator(".activity-terminal-job")).toHaveCount(3);
  await expect(resizeActivity).toHaveAttribute("aria-valuenow", "192");
  await page.screenshot({ path: `${dir}/video-activity-narrow.png` });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete clip" }).click();
  await page.getByText("Generated clips appear here.").waitFor();
  const storage = {
    cache: { bytes: 0, fileCount: 0, retentionDays: 30, maxBytes: 1000 },
    outputs: { bytes: 0, fileCount: 0 }, images: { bytes: 0, fileCount: 0 }, audio: { bytes: 0, fileCount: 0 },
    metadata: { bytes: 0 }, models: { bytes: 1000, preservedOnReset: true },
    disk: { freeBytes: 10000, totalBytes: 20000, reserveBytes: 2000 }, managedBytes: 1000,
  };
  await page.route("**/api/storage/status", (route) => route.fulfill({ json: storage }));
  await page.route("**/api/storage/clear-local-data", (route) => route.fulfill({ json: { storage } }));
  await page.getByRole("button", { name: "Local data", exact: true }).click();
  await page.getByRole("button", { name: "Clear Local Data", exact: true }).click();
  await page.getByRole("group", { name: "Delete local data?" }).getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fern-video-activity"))).toBeNull();
  await navigation.getByRole("button", { name: "Video", exact: true }).click();
  await expect(toggleActivity).toHaveAttribute("aria-expanded", "false");
  await toggleActivity.click();
  await expect(scrollback).toContainText("No generation activity yet.");
  assert.deepEqual(errors, []);
  console.log("Video setup, generation, Stop, service recovery, persistent activity, export, narrow layout, deletion and local reset passed.");
} finally {
  await close();
}
