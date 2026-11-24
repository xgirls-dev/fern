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
let exported;
await page.route("**/references/video-frame.png", (route) => route.fulfill({ body: frame, contentType: "image/png" }));
await page.route("**/fixture/export-video", async (route) => {
  exported = route.request().postData();
  await route.fulfill({ json: {} });
});
await page.addInitScript(() => {
  Object.defineProperty(window.studio, "saveOutputVideo", {
    value: async (name) => {
      await fetch("/fixture/export-video", { method: "POST", body: name });
      return "export.webm";
    },
  });
});
if (process.env.FERN_TEST_WEBM) {
  const body = await readFile(process.env.FERN_TEST_WEBM);
  await page.route("**/outputs/example.webm", (route) => route.fulfill({ body, contentType: "video/webm" }));
} else {
  await page.route("**/outputs/example.webm", (route) => route.fulfill({ status: 204 }));
}
await page.route("**/api/video/status*", (route) => route.fulfill({
  json: { job, clips, model: { runtimeReady: installed, platformSupported: true, runtimeNote: "Install Wan 2.2 Turbo in Models before generating." } },
}));
await page.route("**/api/video/generate", (route) => {
  generated = route.request().postDataJSON();
  job = { ...idle, id: clip.id, status: "running", phase: "Generating frames on Intel GPU…" };
  return route.fulfill({ status: 202, json: { job } });
});
await page.route("**/api/video/stop", (route) => {
  job = { ...job, status: "cancelled", phase: null };
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
  await page.getByRole("button", { name: "Video", exact: true }).click();
  const heading = page.getByRole("heading", { name: "Video", exact: true });
  await heading.waitFor();
  assert(await heading.evaluate((element) => element === document.activeElement));
  await page.getByRole("button", { name: "Open video models" }).click();
  await page.getByRole("heading", { name: "Video models" }).waitFor();
  installed = true;
  await page.getByRole("navigation", { name: "Studio" }).getByRole("button", { name: "Video", exact: true }).click();
  const begin = page.getByRole("button", { name: "Generate video" });
  await begin.waitFor();
  assert(await begin.isDisabled());
  await page.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: frame });
  await page.getByRole("textbox", { name: "Motion prompt" }).fill(clip.prompt);
  await begin.click();
  await page.getByText("Generating frames on Intel GPU…").waitFor();
  assert.equal(generated.prompt, clip.prompt);
  assert.equal(generated.seed, 42);
  assert(generated.referenceImage.startsWith("data:image/png;base64,"));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("Generation stopped.").waitFor();
  await begin.click();
  await page.getByText("Generating frames on Intel GPU…").waitFor();
  clips = [clip];
  job = { ...job, status: "complete", phase: null, output: clip };
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
  await page.setViewportSize({ width: 740, height: 800 });
  const workspace = page.locator(".video-workspace");
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  await page.reload();
  await page.getByRole("button", { name: "Save WebM" }).waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete clip" }).click();
  await page.getByText("Generated clips appear here.").waitFor();
  assert.deepEqual(errors, []);
  console.log("Video setup, reference upload, generation, stop, saved history, export, narrow layout and deletion passed.");
} finally {
  await close();
}
