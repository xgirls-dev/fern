import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";
import { chooseSelectOption } from "./select-option.mjs";

const { page, state, errors, dir, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
const reserve = 512 * 1024 ** 2;
const model = (id, label, kind, bytes, installed = false) => ({
  id, label, kind, bytes, installed, ready: false, minimumFreeBytes: bytes + reserve,
  downloadIncludes: kind === "base" ? ["Speech tokenizer", "Speaker encoder"] : ["Speech tokenizer"],
});
const preset = model("custom-0.6b", "Custom Voice · 0.6B", "custom_voice", 2_174_455_357);
const largePreset = model("custom-1.7b", "Custom Voice · 1.7B", "custom_voice", 4_196_234_229, true);
const clone = model("base-0.6b", "Voice Clone · 0.6B", "base", 2_192_439_518);
const design = model("voice-design-1.7b", "Voice Design · 1.7B", "voice_design", 4_196_233_714);
const draft = "Read this script when I am ready to generate.";
try {
  state.ttsStatus.models = [preset, largePreset, clone, design];
  state.ttsStatus.environmentReady = false;
  const setupCalls = [];
  let generateCalls = 0;
  await page.route("**/api/tts/setup", (route) => {
    const payload = route.request().postDataJSON();
    setupCalls.push(payload);
    Object.assign(state.ttsStatus, {
      id: `setup-${setupCalls.length}`, threadId: payload.threadId, model: payload.model, error: null,
      operation: "setup", status: "setting_up", phase: "Preparing the local speech environment.",
      logs: ["Preparing the local speech environment."], diagnostics: [],
    });
    return route.fulfill({ status: 202, json: { job: state.ttsStatus } });
  });
  await page.route("**/api/tts/generate", (route) => {
    generateCalls += 1;
    return route.fulfill({ status: 500, json: { error: "Unexpected generation during setup." } });
  });

  await page.reload();
  await button("New thread").click();
  await page.getByRole("menuitem", { name: "Create speech", exact: true }).click();
  const setup = button("Set up model");
  const script = page.getByRole("textbox", { name: "Text to speak", exact: true });
  await script.fill(draft);
  await expect(setup).toHaveAccessibleDescription(/Preset voice · 0\.6B\s+Download\s+2\.17 GB\s+Device\s+Intel GPU/);
  await expect(setup).toHaveAccessibleDescription(/Free space\s+At least 2\.72 GB for a fresh model download\s+Includes\s+Speech tokenizer/);
  await expect(setup).toHaveAccessibleDescription(/runtime is set up separately and may need more disk space/);
  await page.setViewportSize({ width: 1080, height: 720 });
  await page.waitForFunction(() => {
    const footer = document.querySelector(".tts-composer-footer");
    const action = [...(footer?.querySelectorAll("button") ?? [])]
      .find((element) => element.textContent.trim() === "Set up model");
    if (!action) return false;
    const panel = footer.getBoundingClientRect();
    const box = action.getBoundingClientRect();
    return window.innerWidth === 1080 && box.height > 0 &&
      box.top >= Math.max(0, panel.top) && box.bottom <= Math.min(window.innerHeight, panel.bottom);
  });
  await page.screenshot({ path: `${dir}/speech-model-setup-light-1080x720.png` });
  await button("Toggle theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: `${dir}/speech-model-setup-dark-1080x720.png` });

  await page.getByRole("button", { name: /^Design a voice/ }).click();
  await expect(setup).toHaveAccessibleDescription(/Voice design · 1\.7B/);
  await page.getByRole("button", { name: /^Clone a voice/ }).click();
  await expect(setup).toHaveAccessibleDescription(/Voice clone · 0\.6B/);
  await expect(setup).toHaveAccessibleDescription(/Includes\s+Speech tokenizer, Speaker encoder/);
  await page.getByRole("button", { name: /^Preset voice/ }).click();
  await expect(setup).toHaveAccessibleDescription(/Preset voice · 1\.7B/);
  await expect(setup).not.toHaveAccessibleDescription(/Download/);
  await page.getByRole("group", { name: "Model size" }).getByRole("button", { name: /^0\.6B/ }).click();

  await button("Models").click();
  await button("Audio").click();
  const audioCard = (name) => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(audioCard(preset.label).getByRole("button", { name: "Install", exact: true }))
    .toHaveAccessibleDescription(/Download\s+2\.17 GB\s+Device\s+Intel GPU\s+Free space\s+At least 2\.72 GB/);
  await expect(audioCard(largePreset.label).getByRole("button", { name: "Set up runtime", exact: true }))
    .toHaveAccessibleDescription(/Device\s+Intel GPU.*runtime is set up separately/);

  await button("Preferences").click();
  await chooseSelectOption(page.getByLabel("Generation device", { exact: true }), "CPU");
  await button("Audio thread: New audio thread").click();
  await expect(script).toHaveValue(draft);
  await expect(setup).toHaveAccessibleDescription(/Device\s+CPU/);
  assert.equal(setupCalls.length, 0, "Opening setup and changing preferences never starts a download.");

  await setup.press("Enter");
  await expect(page.getByText("Setting up model", { exact: true })).toBeVisible();
  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].model, preset.id);
  Object.assign(state.ttsStatus, {
    status: "failed", phase: "Model setup failed.",
    logs: ["Preparing the local speech environment.", "Model setup failed."],
    error: "Free at least 2.72 GB for the remaining speech model files.",
  });
  await expect(page.locator(".tts-header").getByRole("status")).toHaveText("Setup failed");
  await expect(page.locator(".tts-footer-error")).toContainText("Free at least 2.72 GB");
  await expect(script).toHaveValue(draft);
  await setup.press("Enter");
  await expect(page.getByText("Setting up model", { exact: true })).toBeVisible();
  assert.equal(setupCalls.length, 2);
  assert.deepEqual(setupCalls[1], setupCalls[0]);
  Object.assign(preset, { installed: true, ready: true });
  Object.assign(state.ttsStatus, {
    status: "complete", environmentReady: true,
    logs: ["Preparing the local speech environment.", "Model setup complete. Ready to generate speech."],
  });
  await expect(button("Generate speech")).toBeEnabled();
  await expect(script).toHaveValue(draft);
  await expect(script).toBeFocused();
  assert.equal(generateCalls, 0, "Completing setup never sends the script for generation.");
  const activity = page.getByRole("region", { name: "Activity terminal" });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  const scrollback = activity.getByRole("region", { name: "Speech activity scrollback" });
  await expect(scrollback).toContainText("Model setup failed.");
  await expect(scrollback).toContainText("Model setup complete. Ready to generate speech.");
  await expect(scrollback).not.toContainText("Free at least 2.72 GB");
  assert.deepEqual(errors, []);
  console.log("Speech setup explains the selected model and preserves the script and keyboard focus through completion.");
} finally {
  await close();
}
