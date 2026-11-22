import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const notebook = "text-thread-draft-position";
const scratch = "text-thread-other-draft";
const wrapping = "A paragraph of draft text that wraps based on the space available in the composer. ".repeat(5).trim();
const multiline = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the draft keeps its own editing position.`).join("\n");
const { page, state, errors, close } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_DRAFT_POSITION_BUILT === "1", viewport: { width: 1240, height: 820 },
  legacyTextWorkspace: { activeId: notebook, threads: [
    { id: notebook, title: "Notebook", modelId: "local", draft: multiline, messages: [
      { id: "old-question", role: "user", content: "An older prompt I can revise.", createdAt: 1 },
      { id: "old-answer", role: "assistant", content: "Here is the earlier answer.", createdAt: 2 },
    ] },
    { id: scratch, title: "Scratch chat", modelId: "local", draft: "Another draft", messages: [] },
  ] },
  textStatus: { models: [{ name: "Local model", id: "local", format: "gguf", installed: true }], ggufAvailable: true, job: { status: "idle", id: null } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const edit = page.getByRole("textbox", { name: "Edited prompt" });
const capture = (field) => field.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd,
  direction: element.selectionDirection, top: element.scrollTop }));
const setPosition = async (field, start, end, top) => {
  await field.focus();
  await field.evaluate((element, values) => {
    element.setSelectionRange(values.start, values.end, "backward");
    element.scrollTop = values.top;
  }, { start, end, top });
  return capture(field);
};
const height = (field) => field.evaluate((element) => element.getBoundingClientRect().height);
const open = (name) => button(`Text thread: ${name}`).click();

try {
  await expect(composer).toHaveValue(multiline);
  await composer.focus();
  await composer.evaluate((field) => field.setSelectionRange(field.value.length, field.value.length));
  await page.keyboard.insertText("\nAdded to the notebook");
  const notebookText = `${multiline}\nAdded to the notebook`;
  await expect(composer).toHaveValue(notebookText);
  const first = await setPosition(composer, 604, 628, 220);
  assert(first.top > 0);

  await open("Scratch chat");
  await expect(composer).toHaveValue("Another draft");
  await composer.focus();
  const undo = await page.evaluate(() => navigator.platform.startsWith("Mac")) ? "Meta+z" : "Control+z";
  await composer.press(undo);
  await expect(composer).toHaveValue("Another draft");
  const other = await setPosition(composer, 2, 7, 0);

  await open("Notebook");
  await expect(composer).toHaveValue(notebookText);
  await expect.poll(() => capture(composer)).toEqual(first);
  await button("Preferences").click();
  await expect(composer).toHaveCount(0);
  await open("Notebook");
  await expect(composer).toHaveValue(notebookText);
  await expect.poll(() => capture(composer)).toEqual(first);

  await button("Edit message").click();
  await edit.fill(multiline);
  const revision = await setPosition(edit, 504, 516, 174);
  assert(revision.top > 0);
  await open("Scratch chat");
  await expect(composer).toHaveValue("Another draft");
  await expect.poll(() => capture(composer)).toEqual(other);
  await open("Notebook");
  await expect(edit).toHaveValue(multiline);
  await expect.poll(() => capture(edit)).toEqual(revision);
  await expect.poll(() => capture(composer)).toEqual(first);

  await open("Scratch chat");
  await composer.fill(wrapping);
  const wideHeight = await height(composer);
  await page.setViewportSize({ width: 390, height: 820 });
  await expect.poll(() => height(composer)).toBeGreaterThan(wideHeight + 18);
  await expect(composer).toHaveValue(wrapping);
  await page.setViewportSize({ width: 1240, height: 820 });
  await expect.poll(() => height(composer)).toBeCloseTo(wideHeight, 0);
  assert.deepEqual(state.textRequests, []);
  assert.deepEqual(errors, []);
  console.log("Draft and revision selections, internal scroll, native undo isolation, workspace return, and resize behavior passed.");
} finally {
  await close();
}
