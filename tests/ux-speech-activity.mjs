import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, errors, dir, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
const terminal = page.getByRole("region", { name: "Activity terminal" });
const toggle = terminal.getByRole("button", { name: /^Activity/ });
const scrollback = page.getByRole("region", { name: "Speech activity scrollback" });
const generate = button("Generate speech");
const stop = button("Stop audio");
const script = page.getByRole("textbox", { name: "Text to speak" });
const firstPhase = "Preparing a new audio take.";
const renderPhase = "Generating speech tokens on CPU.";
const stoppedLine = "Audio job stopped.";
const savedLine = "Take saved · 1.0s audio · 3.0s total.";
const diagnostic = "Worker detail about a local reference file";
const draft = "Fern keeps the activity for this take.";
let jobs = 0;
const stopRequests = [];
let releaseStop;

try {
  await page.route("**/api/tts/generate", (route) => {
    const { threadId, model } = route.request().postDataJSON();
    Object.assign(state.ttsStatus, {
      id: `speech-job-${++jobs}`, threadId, model, status: "running", operation: "generate",
      startedAt: Date.now() / 1000, finishedAt: null, phase: firstPhase,
      logs: [firstPhase], diagnostics: [diagnostic], error: null, output: null,
    });
    return route.fulfill({ status: 202, json: { job: state.ttsStatus } });
  });
  await page.route("**/api/tts/stop", async (route) => {
    stopRequests.push(route.request().postDataJSON());
    await new Promise((resolve) => { releaseStop = resolve; });
    state.ttsStatus.status = "stopping";
    return route.fulfill({ status: 202, json: { job: state.ttsStatus } });
  });
  const wav = Buffer.alloc(44 + 48_000);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  await page.route("**/audio/test-take.wav", (route) => route.fulfill({ contentType: "audio/wav", body: wav }));

  await button("New thread").click();
  await page.getByRole("menuitem", { name: "Create speech", exact: true }).click();
  await script.fill(draft);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(scrollback).toContainText("No generation activity yet.");
  await generate.click();
  const header = page.locator(".tts-header");
  await expect(header.getByRole("status")).toContainText(firstPhase);
  await expect(header).toContainText(/\d+s elapsed/);
  await expect(stop).toHaveCount(1);
  await expect(scrollback).toContainText(firstPhase);
  await expect(scrollback).not.toContainText(diagnostic);
  await page.getByText("Technical diagnostics (1)", { exact: true }).click();
  await expect(page.locator(".tts-job-diagnostics pre")).toHaveText(diagnostic);

  await button("Preferences").click();
  Object.assign(state.ttsStatus, { phase: renderPhase, logs: [firstPhase, renderPhase] });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fern-speech-activity"))).toContain(renderPhase);
  await expect(button("Audio thread: New audio thread")).toHaveAccessibleDescription("Qwen3-TTS job running");
  await button("Audio thread: New audio thread").click();
  await expect(header.getByRole("status")).toContainText(renderPhase);
  await expect(scrollback).toContainText(renderPhase);

  await button("Toggle theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: `${dir}/speech-activity-dark.png` });
  const resize = terminal.getByRole("separator", { name: "Resize activity terminal" });
  await resize.press("ArrowUp");
  await expect(resize).toHaveAttribute("aria-valuenow", "192");
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(header).toBeInViewport();
  await expect(terminal).toBeInViewport({ ratio: 1 });
  await expect(stop).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.locator(".tts-workspace").evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  await page.screenshot({ path: `${dir}/speech-activity-compact.png` });

  await stop.click();
  await expect(button("Stopping…")).toBeDisabled();
  await expect.poll(() => stopRequests).toEqual([{ jobId: "speech-job-1" }]);
  releaseStop();
  await expect(button("Stopping…")).toBeDisabled();
  Object.assign(state.ttsStatus, { status: "stopped", logs: [firstPhase, renderPhase, stoppedLine] });
  await expect(scrollback).toContainText(stoppedLine);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(header.getByRole("status")).toContainText(firstPhase);
  Object.assign(state.ttsStatus, {
    status: "complete", phase: savedLine, logs: [firstPhase, savedLine], diagnostics: [],
    output: { name: "test-take.wav", url: "/audio/test-take.wav", duration: 1, sampleRate: 24000 },
  });
  await expect(page.getByText("Your take is ready", { exact: true })).toBeVisible();
  await expect(scrollback).toContainText(savedLine);
  await expect(scrollback.locator(".activity-terminal-job")).toHaveCount(2);
  await expect(stop).toHaveCount(0);

  Object.assign(state.ttsStatus, { id: null, threadId: null, status: "idle", operation: null, phase: null, logs: [], output: null });
  await page.reload();
  await expect(script).toHaveValue(draft);
  await expect(scrollback).toContainText(stoppedLine);
  await expect(scrollback).toContainText(savedLine);
  await expect(resize).toHaveAttribute("aria-valuenow", "192");
  await expect(scrollback).not.toContainText(diagnostic);
  await expect(terminal).toBeInViewport({ ratio: 1 });

  const storage = {
    cache: { bytes: 0, fileCount: 0, retentionDays: 30, maxBytes: 1000 },
    outputs: { bytes: 0, fileCount: 0 }, images: { bytes: 0, fileCount: 0 }, audio: { bytes: 0, fileCount: 0 },
    metadata: { bytes: 0 }, models: { bytes: 1000, preservedOnReset: true },
    disk: { freeBytes: 10000, totalBytes: 20000, reserveBytes: 2000 }, managedBytes: 1000,
  };
  await page.route("**/api/storage/status", (route) => route.fulfill({ json: storage }));
  await page.route("**/api/storage/clear-local-data", (route) => route.fulfill({ json: { storage } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await button("Local data").click();
  await button("Clear Local Data").click();
  await page.getByRole("group", { name: "Delete local data?" }).getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fern-speech-activity"))).toBeNull();
  await button("New thread").click();
  await page.getByRole("menuitem", { name: "Create speech", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(scrollback).toContainText("No generation activity yet.");
  assert.deepEqual(errors, []);
  console.log("Speech Activity follows background work and retains stopped and completed takes across reload.");
} finally {
  releaseStop?.();
  await close();
}
