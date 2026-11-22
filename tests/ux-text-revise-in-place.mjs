import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-revise-in-place";
const originalImage = { name: "recipe-result.png", prompt: "A picture of the first step", width: 256, height: 256, modelLabel: "Local image model" };
const { page, state, errors, close } = await fixture({
  builtRenderer: process.env.FERN_REVISE_BUILT === "1", firstRun: true,
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf", supportsVision: true }],
    ggufAvailable: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: id, threads: [{ id, title: "Recipe notes", modelId: "local", draft: "Keep this composer draft",
    messages: [
      { id: "u1", role: "user", content: "Give the ingredients", createdAt: 1 },
      { id: "a1", role: "assistant", content: "Flour and water.", createdAt: 2 },
      { id: "u2", role: "user", content: "Describe the first step", createdAt: 3, includedImage: "recipe.png", includedImageThreadId: "text-thread-image-origin" },
      { id: "a2", role: "assistant", content: "Start by measuring the flour.", createdAt: 5, status: "complete", generatedImage: originalImage,
        alternatives: [{ id: "a2-original", role: "assistant", content: "Set the scale to zero.", createdAt: 4 }] },
    ],
  }] },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const edited = page.getByRole("textbox", { name: "Edited prompt" });
const feed = page.getByRole("log", { name: "Conversation" });
const prompt = feed.locator('[data-chat-message="u2"]');
const history = page.getByRole("region", { name: "Prompt versions" });
const finish = (partialText) => {
  state.textStatus.job = { ...state.textStatus.job, partialText, status: "complete", finishedAt: Date.now() / 1000 };
};

try {
  await page.route(`**/outputs/${originalImage.name}*`, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#71978a"/></svg>',
  }));
  await prompt.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(button("Send revision")).toBeVisible();
  await edited.fill("Describe mixing the dough");
  await edited.press("Control+Enter");
  await expect.poll(() => state.textRequests.length).toBe(1);
  const request = state.textRequests[0];
  assert.equal(request.threadId, id);
  assert.deepEqual(request.messages.map((message) => message.content), [
    "Give the ingredients", "Flour and water.", "Describe mixing the dough",
  ]);
  assert.equal(request.messages.at(-1).includedImage, "recipe.png");
  assert.equal(request.messages.at(-1).imageThreadId, "text-thread-image-origin");
  await expect(composer).toHaveValue("Keep this composer draft");
  await expect(composer).toBeFocused();
  await expect(page.locator(".text-header h2")).toHaveText("Recipe notes");
  await expect(prompt).toContainText("Describe mixing the dough");
  await expect(feed.getByText("Start by measuring the flour.")).toHaveCount(0);
  finish("Mix flour and water until just combined.");
  await expect(feed.getByText("Mix flour and water until just combined.")).toBeVisible();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.map((thread) => [
    thread.id, thread.messages.find((message) => message.id === "u2")?.promptAlternatives?.[0]?.response?.id,
    thread.messages.at(-1)?.content,
  ])).toEqual([[id, "a2", "Mix flour and water until just combined."]]);
  await page.reload();

  await prompt.getByRole("button", { name: "Prompt versions", exact: true }).click();
  await expect(history).toContainText("Describe the first step");
  await expect(history).toContainText("Start by measuring the flour.");
  await history.getByRole("button", { name: "Review image 1: A picture of the first step" }).click();
  await expect(page.getByRole("dialog").getByAltText("A picture of the first step")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(history).toBeVisible();
  await page.setViewportSize({ width: 390, height: 660 });
  await expect.poll(() => history.evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    const thumbnail = panel.querySelector("img")?.getBoundingClientRect();
    return panel.scrollWidth <= panel.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth &&
      thumbnail?.width > 0 && thumbnail.width <= 160;
  })).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await history.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(prompt.locator(":scope > .text-message-content")).toContainText("Describe the first step");
  await expect(feed.locator('[data-chat-message="a2"]')).toContainText("Start by measuring the flour.");
  await expect(feed.locator('[data-chat-message="a2"]').getByRole("group", { name: "Response versions" })).toContainText("2 / 2");
  await expect(composer).toHaveValue("Keep this composer draft");
  assert.equal(state.textRequests.length, 1);
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.deepEqual(state.textRequests[1].messages.map((message) => message.content), [
    "Give the ingredients", "Flour and water.", "Describe the first step", "Start by measuring the flour.", "Keep this composer draft",
  ]);
  assert.equal(state.textRequests[1].messages[3].generatedImage, originalImage.name);
  finish("Ready for the next step.");
  await expect(feed.getByText("Ready for the next step.")).toBeVisible();

  await prompt.getByRole("button", { name: "Prompt versions", exact: true }).click();
  await expect(history).toContainText("Describe mixing the dough");
  await expect(history).toContainText("Mix flour and water until just combined.");
  await expect(history.getByRole("button", { name: "Restore this version" })).toHaveCount(0);
  await expect(prompt.locator(":scope > .text-message-content")).toContainText("Describe the first step");

  const latestPrompt = feed.getByRole("article", { name: "Your message" }).last();
  await latestPrompt.getByRole("button", { name: "Edit message", exact: true }).click();
  await edited.fill("Revise the follow-up");
  state.rejectText = "The local runtime rejected this revision.";
  await button("Send revision").click();
  await expect(feed.getByText(state.rejectText, { exact: true })).toBeVisible();
  await latestPrompt.getByRole("button", { name: "Prompt versions", exact: true }).click();
  const latestHistory = latestPrompt.getByRole("region", { name: "Prompt versions" });
  await expect(latestHistory).toContainText("Ready for the next step.");
  await latestHistory.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(feed.getByText("Ready for the next step.")).toBeVisible();
  await expect(feed.getByText(state.rejectText, { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("In-place prompt revision, persisted prompt/reply versions, attachment provenance, and restored follow-up context passed.");
} finally {
  await close();
}
