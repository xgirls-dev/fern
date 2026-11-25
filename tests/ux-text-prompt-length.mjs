import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const threadId = "text-thread-prompt-length";
const longPrompt = "Plan a garden. ".repeat(1500) + "Keep the butterfly 🦋 at the end.";
const boundaryPrompt = "a".repeat(19_999) + "🦋";
const limitNotice = "OpenVINO accepts up to 20,000 characters per message.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [
      { id: "gguf", name: "GGUF model", format: "gguf", installed: true },
      { id: "openvino", name: "OpenVINO model", format: "openvino", installed: true },
    ],
    ggufAvailable: true, runtimeAvailable: true, job: { id: null, status: "idle" },
  },
  legacyTextWorkspace: { activeId: threadId, threads: [{ id: threadId, title: "Garden notes", modelId: "gguf", messages: [
    { id: "prompt", role: "user", content: "Plan a garden", createdAt: 1 },
    { id: "answer", role: "assistant", content: "Choose a sunny spot.", createdAt: 2 },
  ] }] },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const editor = page.getByRole("textbox", { name: "Edited prompt", exact: true });
const send = page.getByRole("button", { name: "Send message", exact: true });
const sendRevision = page.getByRole("button", { name: "Send revision", exact: true });
async function selectModel(name) {
  await page.getByRole("button", { name: /^Text model:/ }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

try {
  await composer.fill(longPrompt);
  await expect(composer).toHaveValue(longPrompt);
  await expect(composer).not.toHaveAttribute("aria-invalid");
  await expect(send).toBeEnabled();
  await expect(page.locator(".text-keyboard-hint")).toHaveText("Enter to send · Shift + Enter for newline");

  await selectModel("OpenVINO model");
  await expect(composer).toHaveValue(longPrompt);
  await expect(composer).toHaveAttribute("aria-invalid", "true");
  await expect(composer).toHaveAccessibleDescription(limitNotice + " Shorten the draft or choose a GGUF model.");
  await expect(send).toBeDisabled();
  await composer.press("Enter");
  assert.equal(state.textRequests.length, 0);
  await composer.fill(boundaryPrompt);
  await expect(composer).toHaveValue(boundaryPrompt);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 550, height: viewport.height });
  const count = page.getByText("20,000 / 20,000", { exact: true });
  await expect(count).toBeVisible();
  await page.setViewportSize(viewport);
  await expect(send).toBeEnabled();

  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await editor.fill(longPrompt);
  await expect(editor).toHaveValue(longPrompt);
  await expect(editor).toHaveAccessibleDescription(limitNotice);
  await expect(editor).toHaveAttribute("aria-invalid", "true");
  await expect(sendRevision).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open branch draft", exact: true })).toBeEnabled();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find(thread => thread.id === threadId)?.promptEdit?.content).toEqual(longPrompt);
  await page.reload();
  await expect(editor).toHaveValue(longPrompt);
  await expect(sendRevision).toBeDisabled();

  await selectModel("GGUF model");
  await expect(editor).toHaveValue(longPrompt);
  await expect(editor).not.toHaveAttribute("aria-invalid");
  await expect(sendRevision).toBeEnabled();
  await sendRevision.click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert.equal(state.textRequests[0].messages.at(-1).content, longPrompt);
  await expect(composer).toHaveValue(boundaryPrompt);
  assert.deepEqual(errors, []);
  console.log("Long GGUF drafts and revisions survive model switching and reload. OpenVINO enforces the Unicode character limit at send time.");
} finally {
  await close();
}
