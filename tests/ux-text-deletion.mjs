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
  assert.deepEqual(errors, []);
  console.log("Chat deletion, per-chat undo history, keyboard focus, archived reply restoration, image context, retry reconciliation, and durable dismissal passed.");
} finally {
  await close();
}
