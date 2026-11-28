import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const sourceId = "text-thread-edit-source";
const imageOwner = "text-thread-image-source";
const { page, errors, state, dir, close } = await fixture({ firstRun: true,
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf", supportsVision: true }], ggufAvailable: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: sourceId, threads: [{
    id: sourceId, title: "Planning chat", modelId: "local", systemPrompt: "Use concise language.", draft: "My separate composer draft",
    messages: [
      { id: "u1", role: "user", content: "Set up a summary", createdAt: 1 },
      { id: "a1", role: "assistant", content: "The earlier answer stays in context.", createdAt: 2 },
      { id: "u2", role: "user", content: "Review the selected image", includedImage: "original.png", includedImageThreadId: imageOwner, createdAt: 3 },
      { id: "a2", role: "assistant", content: "The original image review.", createdAt: 4 },
      { id: "u3", role: "user", content: "Give me a meeting plan", createdAt: 5 },
      { id: "a3", role: "assistant", content: "This turn comes after the prompt being edited.", createdAt: 6 },
    ],
  }] },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const edited = page.getByRole("textbox", { name: "Edited prompt" });
const heading = page.locator(".text-header h2");
const conversation = page.getByRole("log", { name: "Conversation" });
const editAt = (index) => conversation.getByRole("article", { name: "Your message" }).nth(index).getByRole("button", { name: "Edit message" });

try {
  if (await page.locator("html").getAttribute("data-theme") !== "dark") await button("Toggle theme").click();
  await editAt(1).click();
  await expect(edited).toBeFocused();
  await edited.blur();
  const shades = await edited.evaluate((field) => ({
    input: getComputedStyle(field).backgroundColor,
    surface: getComputedStyle(field.closest(".text-user-bubble")).backgroundColor,
  }));
  const shade = (color) => Number(color.match(/\d+/)?.[0]);
  assert(shade(shades.input) >= shade(shades.surface), `The edit field is darker than its message bubble: ${JSON.stringify(shades)}`);
  await edited.focus();
  await expect(editAt(0)).toBeDisabled();
  await expect(heading).toHaveText("Planning chat");
  await expect(composer).toHaveValue("My separate composer draft");
  await edited.fill("Temporary edit");
  await edited.press("Escape");
  await expect(editAt(1)).toBeFocused();
  await expect(conversation.getByText("Review the selected image", { exact: true })).toBeVisible();
  assert.equal(state.textRequests.length, 0);

  await editAt(1).click();
  await edited.fill("Compare the colors in the selected image");
  await page.setViewportSize({ width: 820, height: 660 });
  await expect.poll(() => page.getByRole("form", { name: "Edit prompt" }).evaluate((form) => {
    const rect = form.getBoundingClientRect();
    const viewport = form.closest(".text-conversation").getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && form.scrollWidth <= form.clientWidth && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
  })).toBe(true);
  await page.screenshot({ path: `${dir}/chat-inline-editor-compact.png` });
  await page.reload();
  await expect(edited).toHaveValue("Compare the colors in the selected image");
  await expect(composer).toHaveValue("My separate composer draft");

  state.rejectText = "The runtime could not start this reply.";
  await edited.press("Control+Enter");
  await expect(heading).toHaveText("Planning chat (branch)");
  await expect(conversation.getByText(state.rejectText, { exact: true })).toBeVisible();
  assert.equal(state.textRequests.length, 1);
  const request = state.textRequests[0];
  assert.notEqual(request.threadId, sourceId);
  assert.equal(request.systemPrompt, "Use concise language.");
  assert.deepEqual(request.messages.map((message) => message.content), [
    "Set up a summary", "The earlier answer stays in context.", "Compare the colors in the selected image",
  ]);
  assert.equal(request.messages.at(-1).includedImage, "original.png");
  assert.equal(request.messages.at(-1).imageThreadId, imageOwner);

  await button("Open original chat").click();
  await expect(heading).toHaveText("Planning chat");
  await expect(conversation.getByText("The original image review.")).toBeVisible();
  await expect(composer).toHaveValue("My separate composer draft");
  await expect(edited).toHaveCount(0);

  state.rejectText = null;
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  await editAt(0).click();
  await edited.fill("Start with the project risks instead\n\n");
  await expect(button("Send in new chat")).toBeDisabled();
  await button("Open branch draft").click();
  await expect(heading).toHaveText("Planning chat (branch)");
  await expect(composer).toHaveValue("Start with the project risks instead\n\n");
  await expect(composer).toBeFocused();
  await expect(conversation.getByRole("article")).toHaveCount(0);
  assert.equal(state.textRequests.length, 2);
  assert.deepEqual(errors, []);
  console.log("Inline edit, keyboard cancellation, draft recovery, attached-image branching, rejected replies, and return to source passed.");
} finally {
  await close();
}
