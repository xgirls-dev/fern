import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-deletion";
const otherId = "text-thread-deletion-other";
const artifact = {
  name: "chat-image-0123456789abcdef0123456789abcdef.png",
  prompt: "A restored poster", width: 256, height: 256, modelLabel: "Local image model",
};
const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_DELETION_BUILT === "1",
  firstRun: true,
  legacyTextWorkspace: { activeId: id, threads: [
    { id, title: "First chat", modelId: "local", draft: "Keep my draft", messages: [
      { id: "first-prompt", role: "user", content: "Create a poster", createdAt: 1 },
      { id: "poster", role: "assistant", content: "Here is the poster", createdAt: 3, generatedImage: artifact,
        alternatives: [{ id: "poster-first", role: "assistant", content: "First poster reply", createdAt: 2 }] },
      { id: "next-prompt", role: "user", content: "Describe the composition", createdAt: 4 },
      { id: "description", role: "assistant", content: "An earlier description", createdAt: 5 },
    ] },
    { id: otherId, title: "Second chat", modelId: "local", draft: "Other chat draft", messages: [
      { id: "other-prompt", role: "user", content: "A lone prompt", createdAt: 6 },
    ] },
    { id: "text-thread-snapshots", title: "Chat with snapshots", modelId: "local", messages: [
      { id: "current-notes", role: "user", content: "Current notes", createdAt: 7 },
      { id: "current-notes-reply", role: "assistant", content: "Current notes answer", createdAt: 9,
        alternatives: [{ id: "first-notes-reply", role: "assistant", content: "First notes answer", createdAt: 8 }] },
    ], versions: [{ id: "old-notes", label: "Old notes", messages: [
      { id: "old-notes-prompt", role: "user", content: "Old notes prompt", createdAt: 1 },
      { id: "old-notes-reply", role: "assistant", content: "Old notes answer", createdAt: 2 },
    ] }] },
  ] },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf", supportsVision: true }],
    ggufAvailable: true, job: { id: null, status: "idle" } },
});

const feed = page.getByRole("log", { name: "Conversation" });
const row = (id) => feed.locator(`[data-chat-message="${id}"]`);
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const undo = button("Undo deletion");
const selection = button("Remove selected conversation image");
const confirmation = page.getByRole("group", { name: "Confirm message deletion" });
const savedIds = async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === id).messages.map((message) => message.id);

async function remove(target, action, description) {
  await chooseMessageAction(row(target), action);
  await expect(confirmation).toContainText(description);
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row(target)).toHaveCount(0);
  await expect(undo).toBeFocused();
}

try {
  await page.route(`**/outputs/${artifact.name}*`, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#71978a"/></svg>',
  }));
  await page.reload();
  await button("Include this image again").click();
  await expect(selection).toBeVisible();
  await remove("first-prompt", "Delete message", "Delete this message and its reply?");
  await expect(row("poster")).toHaveCount(0);
  await expect(selection).toHaveCount(0);
  await expect.poll(savedIds).toEqual(["next-prompt", "description"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button("Jump to latest message")).toHaveCount(0);
  assert(await undo.evaluate((button) => {
    const notice = button.parentElement;
    return notice.scrollWidth <= notice.clientWidth &&
      [...notice.querySelectorAll("button")].every((item) => item.getBoundingClientRect().right <= window.innerWidth);
  }), "Undo and dismissal should fit in a narrow conversation");
  await page.setViewportSize({ width: 1440, height: 900 });

  await button("Text thread: Second chat").click();
  await expect(composer).toHaveValue("Other chat draft");
  await expect(undo).toHaveCount(0);
  await remove("other-prompt", "Delete message", "Delete this message?");
  await expect(page.getByText("Message deleted.", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(row("other-prompt")).toBeFocused();
  await expect(undo).toHaveCount(0);

  await button("Text thread: First chat").click();
  await expect(page.getByText("Message and reply deleted.", { exact: true })).toBeVisible();
  await undo.click();
  await expect(row("first-prompt")).toBeFocused();
  await expect(row("poster")).toContainText("Here is the poster");
  await expect(row("poster").getByLabel("Response versions")).toContainText("2 / 2");
  await expect(selection).toBeVisible();
  await expect(composer).toHaveValue("Keep my draft");
  await expect.poll(savedIds).toEqual(["first-prompt", "poster", "next-prompt", "description"]);

  const poster = row("poster");
  await poster.getByRole("button", { name: "Previous response version" }).click();
  await expect(poster).toContainText("First poster reply");
  await chooseMessageAction(poster, "Delete this version");
  await expect(confirmation).toHaveAccessibleDescription("Delete reply version 1?");
  await page.keyboard.press("Escape");
  await expect(poster.getByRole("button", { name: "More message actions" })).toBeFocused();
  await expect(poster).toContainText("First poster reply");
  await chooseMessageAction(poster, "Delete this version");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).press("Enter");
  await expect(undo).toBeFocused();
  await expect(undo).toHaveAccessibleDescription("Reply version deleted.");
  await expect(poster).toContainText("Here is the poster");
  await expect(poster.getByLabel("Response versions")).toHaveCount(0);
  await expect(selection).toBeVisible();
  await expect.poll(savedIds).toEqual(["first-prompt", "poster", "next-prompt", "description"]);
  await undo.click();
  await expect(poster).toBeFocused();
  await expect(poster.getByLabel("Response versions")).toContainText("1 / 2");
  await poster.getByRole("button", { name: "Next response version" }).click();
  await expect(poster).toContainText("Here is the poster");

  await remove("description", "Delete reply", "Delete this reply?");
  await button("Retry response").click();
  await expect(undo).toBeDisabled();
  await expect(page.getByText("Reply deleted. Undo is available after the response.")).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The newly generated description", finishedAt: Date.now() / 1000 };
  await expect(undo).toBeEnabled();
  await undo.click();
  const latest = feed.getByRole("article", { name: "Model response" }).last();
  await expect(latest).toBeFocused();
  await expect(latest).toContainText("The newly generated description");
  await expect(latest.getByLabel("Response versions")).toContainText("2 / 2");
  await latest.getByRole("button", { name: "Previous response version" }).click();
  await expect(latest).toContainText("An earlier description");
  await latest.getByRole("button", { name: "Next response version" }).click();
  await expect(latest).toContainText("The newly generated description");
  const selectedReplyId = await latest.getAttribute("data-chat-message");
  await chooseMessageAction(latest, "Delete this version");
  await expect(confirmation).toHaveAccessibleDescription("Delete reply version 2?");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(undo).toBeFocused();
  await expect(latest).toContainText("An earlier description");
  await expect(latest.getByLabel("Response versions")).toHaveCount(0);
  await expect.poll(savedIds).toEqual(["first-prompt", "poster", "next-prompt", "description"]);
  await undo.press("Enter");
  await expect(latest).toBeFocused();
  await expect(latest).toHaveAttribute("data-chat-message", selectedReplyId);
  await expect(latest).toContainText("The newly generated description");
  await expect(latest.getByLabel("Response versions")).toContainText("2 / 2");

  await remove("poster", "Delete reply", "Delete this reply and its other versions?");
  await expect(selection).toHaveCount(0);
  await composer.fill("This draft now has a different purpose");
  await undo.click();
  await expect(row("poster")).toBeFocused();
  await expect(selection).toHaveCount(0);
  await expect(composer).toHaveValue("This draft now has a different purpose");

  const nextReplyId = await latest.getAttribute("data-chat-message");
  await remove("first-prompt", "Delete message", "Delete this message and its reply?");
  await remove("next-prompt", "Delete message", "Delete this message and its reply?");
  await expect(page.getByText(/2 deletions to undo/)).toBeVisible();
  await expect.poll(savedIds).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(row("next-prompt")).toBeFocused();
  await expect(row(nextReplyId)).toContainText("The newly generated description");
  await expect(row("first-prompt")).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(row("first-prompt")).toBeFocused();
  await expect(undo).toHaveCount(0);
  await expect.poll(savedIds).toEqual(["first-prompt", "poster", "next-prompt", nextReplyId]);

  await remove("first-prompt", "Delete message", "Delete this message and its reply?");
  await remove(nextReplyId, "Delete reply", "Delete this reply and its other versions?");
  const revisedPrompt = row("next-prompt");
  await revisedPrompt.getByRole("button", { name: "Edit message", exact: true }).click();
  await page.getByRole("textbox", { name: "Edited prompt" }).fill("Describe the revised composition");
  await button("Send revision").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.deepEqual(state.textRequests.at(-1).messages.map((message) => message.content), ["Describe the revised composition"]);
  await expect(page.getByText(/2 deletions to undo/)).toBeVisible();
  await expect(undo).toBeDisabled();
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The revised description", finishedAt: Date.now() / 1000 };
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(revisedPrompt).toBeFocused();
  await expect(page.getByText("Reply restored to Prompt versions.")).toBeVisible();
  const promptVersions = revisedPrompt.getByRole("button", { name: "Prompt versions", exact: true });
  await promptVersions.click();
  const savedVersions = revisedPrompt.getByRole("region", { name: "Prompt versions" });
  await expect(savedVersions).toContainText("Describe the composition");
  await expect(savedVersions).toContainText("The newly generated description");
  await expect(latest).toContainText("The revised description");
  await promptVersions.click();
  await undo.click();
  await expect(row("first-prompt")).toBeFocused();
  await expect(undo).toHaveCount(0);

  await remove("poster", "Delete reply", "Delete this reply and its other versions?");
  await button("Dismiss deletion notice").click();
  await expect(composer).toBeFocused();
  await expect(undo).toHaveCount(0);
  await expect.poll(savedIds).not.toContain("poster");
  await page.reload();
  await expect(row("next-prompt")).toBeVisible();
  await expect(row("poster")).toHaveCount(0);
  await expect(undo).toHaveCount(0);

  await button("Text thread: Chat with snapshots").click();
  await remove("current-notes-reply", "Delete this version", "Delete reply version 2?");
  const notesReply = feed.getByRole("article", { name: "Model response" });
  await expect(notesReply).toContainText("First notes answer");
  await notesReply.getByRole("button", { name: "Regenerate response", exact: true }).click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Regenerated notes answer", finishedAt: Date.now() / 1000 };
  await expect(notesReply).toContainText("Regenerated notes answer");
  await expect(undo).toBeEnabled();
  const conversationVersions = page.getByRole("combobox", { name: "Conversation versions", exact: true });
  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Old notes", exact: true }).click();
  await expect(notesReply).toContainText("Old notes answer");
  await undo.press("Enter");
  await expect(composer).toBeFocused();
  await expect(notesReply).toContainText("Old notes answer");
  await expect(page.getByText("Reply version restored in conversation history.")).toBeVisible();
  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Current notes", exact: true }).click();
  await expect(notesReply).toContainText("Regenerated notes answer");
  await expect(notesReply.getByLabel("Response versions")).toContainText("3 / 3");
  await notesReply.getByRole("button", { name: "Previous response version" }).click();
  await expect(notesReply).toContainText("Current notes answer");

  await composer.fill("A draft that belongs to this chat");
  await remove("current-notes", "Delete message", "Delete this message and its reply?");
  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Old notes prompt", exact: true }).click();
  await expect(notesReply).toContainText("Old notes answer");
  await undo.click();
  await expect(row("current-notes")).toHaveCount(0);
  await expect(notesReply).toHaveText(/Old notes answer/);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("A draft that belongs to this chat");
  await expect(page.getByText("Message and reply restored in conversation history.")).toBeVisible();
  await expect.poll(async () => {
    const workspace = await savedTextWorkspace(page);
    const thread = workspace.threads.find(({ title }) => title === "Chat with snapshots");
    return { current: thread.messages.map(({ id }) => id), archived: thread.versions[0].messages.map(({ id }) => id) };
  }).toEqual({ current: ["old-notes-prompt", "old-notes-reply"], archived: ["current-notes", "current-notes-reply"] });

  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Previous conversation", exact: true }).click();
  await expect(row("current-notes")).toBeVisible();
  await expect(notesReply).toContainText("Current notes answer");
  await expect(notesReply.getByLabel("Response versions")).toContainText("2 / 3");

  await remove("current-notes-reply", "Delete reply", "Delete this reply and its other versions?");
  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Old notes prompt", exact: true }).click();
  await expect(notesReply).toContainText("Old notes answer");
  await conversationVersions.press("ArrowDown");
  await page.getByRole("option", { name: "Current notes", exact: true }).click();
  await expect(notesReply).toHaveCount(0);
  await undo.click();
  await expect(row("current-notes-reply")).toBeFocused();
  await expect(notesReply).toContainText("Current notes answer");
  await expect(undo).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Chat and reply-version deletion, per-chat undo history, keyboard focus, archived reply restoration, image context, retry reconciliation, and durable dismissal passed.");
} finally {
  await close();
}
