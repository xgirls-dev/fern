import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", installed: true, format: "gguf", supportsVision: true };
const { page, state, errors, close } = await fixture({ firstRun: true, textStatus: {
  models: [model], ggufAvailable: true, job: { id: null, status: "idle" },
} });

const chosen = "Use the direct route";
const alternative = "Use the scenic route";
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const conversation = page.getByRole("log", { name: "Conversation" });
const firstReply = conversation.getByRole("article", { name: "Model response" }).first();

try {
  const id = "text-thread-route";
  await savedTextWorkspace(page, { activeId: id, threads: [{
      id, title: "Route planner", modelId: "local", draft: "Keep this draft", messages: [
        { id: "first-prompt", role: "user", content: "Which route?", createdAt: 1 },
        { id: "direct", role: "assistant", content: chosen, createdAt: 3, alternatives: [
          { id: "scenic", role: "assistant", content: alternative, reasoning: "The hidden waterfall is worth visiting.", createdAt: 2 },
        ] },
        { id: "second-prompt", role: "user", content: "How long will it take?", createdAt: 4 },
        { id: "duration", role: "assistant", content: "About three hours.", createdAt: 5 },
      ],
  }] });
  await page.reload();
  await expect(firstReply).toContainText(chosen);
  await page.evaluate(() => {
    window.pendingCopies = [];
    window.studio.copyText = (text) => new Promise((resolve, reject) => {
      window.pendingCopies.push({ text, resolve, reject });
    });
  });
  const copyMessage = firstReply.getByRole("button", { name: "Copy message", exact: true });
  await copyMessage.click();
  await firstReply.getByRole("button", { name: "Previous response version" }).click();
  await expect(firstReply).toContainText(alternative);
  await expect(firstReply).toContainText("Chat uses version 2");
  await copyMessage.click();
  assert.deepEqual(await page.evaluate(() => window.pendingCopies.map(({ text }) => text)), [chosen, alternative]);
  await page.evaluate(() => window.pendingCopies[1].resolve());
  await expect(firstReply.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await page.evaluate(() => window.pendingCopies[0].resolve());
  await expect(firstReply.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft");

  await button("Search threads").click();
  const search = page.getByRole("searchbox", { name: "Find a thread" });
  await search.fill("hidden waterfall");
  await expect(page.getByRole("dialog")).toContainText("The hidden waterfall is worth visiting.");
  await search.press("Enter");
  await expect(page.getByRole("searchbox", { name: "Search this chat" })).toHaveValue("hidden waterfall");
  await expect(firstReply).toHaveAttribute("data-find-match", "true");
  await expect(firstReply.getByText("The hidden waterfall is worth visiting.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button("Find in chat")).toBeFocused();

  await chooseMessageAction(firstReply, "Branch from response");
  await expect(page.locator(".text-header h2")).toHaveText("Route planner (branch)");
  await expect(firstReply).toContainText(alternative);
  await expect(firstReply).not.toContainText("Chat uses version");
  await expect(conversation.getByText("About three hours.")).toHaveCount(0);
  await composer.fill("Is there a lookout?");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert.equal(state.textRequests[0].messages[1].content, alternative);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "There is a lookout.", finishedAt: Date.now() / 1000 };
  await expect(conversation.getByText("There is a lookout.")).toBeVisible();

  await button("Text thread: Route planner").click();
  await expect(firstReply).toContainText(alternative);
  await expect(composer).toHaveValue("Keep this draft");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.deepEqual(state.textRequests[1].messages.map((message) => message.content), [
    "Which route?", chosen, "How long will it take?", "About three hours.", "Keep this draft",
  ]);
  assert.deepEqual(errors, []);
  console.log("Historical versions, clipboard feedback, reasoning search, exact-version branching and unchanged source context passed.");
} finally {
  await close();
}
