import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-output-limit";
const model = { id: "local", name: "Local model", format: "gguf", installed: true, supportsVision: true, supportsReasoning: true };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const image = "chat-image-0123456789abcdef0123456789abcdef.png";
const metrics = { inputTokens: 50, outputTokens: 64, maxNewTokens: 64, generationSeconds: 2, tokensPerSecond: 32 };
const { page, state, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_OUTPUT_LIMIT_BUILT === "1",
  legacyTextWorkspace: { activeId: id, threads: [{ id, modelId: model.id, title: "Workshop notes", messages: [] }] },
  textStatus: { models: [model], ggufAvailable: true, job: { id: null, status: "idle" } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const feed = page.getByRole("log", { name: "Conversation" });
const replies = feed.getByRole("article", { name: "Model response" });
const announcement = page.getByRole("status", { name: "Reply status" });
const saved = async () => (await savedTextWorkspace(page))?.threads.find((thread) => thread.id === id);
const complete = (finishReason, partialText, partialReasoning = "") => {
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText, partialReasoning,
    result: { ...metrics, finishReason }, finishedAt: Date.now() / 1000 };
};

try {
  await page.route("**/api/text/images", (route) => route.fulfill({ status: 201, json: { image } }));
  await page.route(`**/references/${image}`, (route) => route.fulfill({ contentType: "image/png", body: png }));
  await composer.fill("Write the workshop notes.");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);

  const cutoff = "The last item on the agenda was";
  const longReply = "The workshop opened with a demonstration. ".repeat(510) + cutoff;
  complete("length", longReply);
  await expect(replies.last()).toContainText("Reached the output limit");
  await expect(announcement).toHaveText("Reply reached the output limit. Partial reply available.");
  await expect(button("Continue response")).toBeEnabled();
  await expect.poll(async () => (await saved())?.messages.at(-1).metrics?.finishReason).toBe("length");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(replies.last()).toContainText(cutoff);
  await composer.fill("Keep this unrelated draft.");
  await page.getByLabel("Chat image file", { exact: true }).setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("Image to send")).toBeVisible();
  await button("Continue response").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  const request = state.textRequests.at(-1);
  assert.deepEqual(request.messages.map(({ role }) => role), ["user", "assistant", "user"]);
  assert(!request.messages[1].content.includes(cutoff));
  assert(request.messages[2].content.endsWith(cutoff));
  assert(!request.messages[2].content.includes("unrelated draft"));
  assert.equal(request.messages[2].image, undefined);
  assert.equal(request.imageModel, undefined);
  await expect(composer).toHaveValue("Keep this unrelated draft.");
  await expect(page.getByAltText("Image to send")).toBeVisible();
  await expect.poll(async () => (await saved())?.messages.at(-1).content).toBe("Continue from where you stopped. Avoid repeating what you already wrote.");

  complete("stop", "a quick review of the checklist.");
  await expect(replies.last()).toContainText("a quick review of the checklist.");
  await expect(announcement).toHaveText("Reply ready.");
  await expect(replies.last().getByText("Reached the output limit")).toHaveCount(0);
  await expect(button("Continue response")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await button("Regenerate response").click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  assert.equal(state.textRequests.at(-1).messages.at(-1).content, request.messages[2].content);
  complete("length", "", "I will review the notes before writing the answer.");
  await expect(replies.last()).toContainText("The model reached the output limit before finishing an answer.");
  await expect(replies.last().getByText("Reasoning", { exact: true })).toBeVisible();
  await expect(announcement).toHaveText("The model reached the output limit before finishing an answer.");
  await expect(button("Continue response")).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this unrelated draft.");
  await expect(page.getByAltText("Image to send")).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Output-limit notices, durable continuation, draft isolation, regeneration, and reasoning-only cutoff passed.");
} finally {
  await close();
}
