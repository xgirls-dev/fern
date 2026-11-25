import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseSelectOption } from "./select-option.mjs";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const posters = [
  { name: "red-poster.png", prompt: "Red circle poster", color: "#b83e2c" },
  { name: "blue-poster.png", prompt: "Blue circle poster", color: "#3a6480" },
  { name: "green-poster.png", prompt: "Green circle poster", color: "#48624f" },
];
const archivedPoster = { name: "archived-poster.png", prompt: "Archived poster", color: "#b6925a" };
const id = "text-thread-review";
const legacyTextWorkspace = { activeId: id, threads: [{
      id, title: "Poster", draft: "Keep this draft.", updatedAt: Date.now(),
      messages: posters.flatMap(({ name, prompt }, i) => [
        { id: `u-${i}`, role: "user", content: prompt, createdAt: Date.now() },
        { id: `a-${i}`, role: "assistant", content: "Here is your poster.", status: "complete", createdAt: Date.now(),
          generatedImage: { name, prompt, modelLabel: "Klein 4B", width: 512, height: 512 },
          metrics: {
            inputTokens: 20, outputTokens: 10, generationSeconds: 1, tokensPerSecond: 10,
            visionChecked: i === 0,
            ...(i === 2 ? { context: { size: 4096, compactedMessages: 2, images: 2, imageNames: posters.slice(1).map(({ name }) => name) } } : {}),
          } },
      ]),
      versions: [{ id: "archive", label: "Early poster", messages: [
        { id: "archive-prompt", role: "user", content: "Make a poster for the archive.", createdAt: 1 },
        { id: "archive-poster", role: "assistant", content: "The archive poster is ready.", createdAt: 2,
          generatedImage: { name: archivedPoster.name, prompt: archivedPoster.prompt, modelLabel: "Klein 4B", width: 512, height: 512 } },
        { id: "archive-review", role: "user", content: "Check the poster lines.", includedImage: archivedPoster.name, createdAt: 3 },
        { id: "archive-answer", role: "assistant", content: "The poster has clear lines.", createdAt: 4 },
      ] }],
}] };

const { page, state, errors, dir, close } = await fixture({
  viewport: { width: 1440, height: 920 },
  legacyTextWorkspace,
  holdApiOnReload: true,
  textStatus: {
    models: [{ id: "gemma", name: "Gemma", installed: true, format: "gguf", supportsVision: true }],
    ggufAvailable: true, runtimeAvailable: true, job: { id: null, status: "idle" },
  },
});
try {
  let redMissing = false;
  let connecting = false;
  const prematureRequests = [];
  for (const { name, color } of [...posters, archivedPoster]) {
    await page.route(`**/outputs/${name}*`, (route) => {
      if (connecting) prematureRequests.push(name);
      return connecting || (redMissing && name === posters[0].name)
        ? route.fulfill({ status: 404 })
        : route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#efdfc0"/><circle cx="256" cy="256" r="140" fill="${color}"/></svg>` });
    });
  }
  connecting = true;
  await page.evaluate(() => sessionStorage.setItem("fern-fixture-hold-api", "1"));
  await page.reload();
  await page.getByRole("button", { name: "Text thread: Poster", exact: true }).click();
  await expect(page.getByText("Opening saved image…", { exact: true })).toHaveCount(posters.length);
  assert.deepEqual(prematureRequests, []);
  connecting = false;
  await page.evaluate(() => {
    sessionStorage.removeItem("fern-fixture-hold-api");
    window.dispatchEvent(new Event("fern-fixture-connect-api"));
  });
  const open = page.getByRole("button", { name: "Review image 1: Red circle poster", exact: true });
  await open.waitFor();
  assert.equal(await page.getByText(/Image checked/).count(), 1);
  await open.focus();
  await page.keyboard.press("Enter");
  const viewer = page.getByRole("dialog");
  await viewer.waitFor();
  await viewer.getByAltText("Red circle poster").waitFor();
  await page.screenshot({ path: `${dir}/chat-image-review-win32-fixture-light-1440x920.png` });
  await viewer.getByRole("button", { name: /Next/ }).click();
  await viewer.getByAltText("Blue circle poster").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Review image 1: Red circle poster");
  assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this draft.");
  assert.deepEqual(state.openedImages, []);

  redMissing = true;
  await page.reload();
  await page.getByRole("button", { name: "Text thread: Poster", exact: true }).click();
  const unavailable = page.locator(".text-generated-artifact").filter({ hasText: "Image unavailable" });
  await unavailable.scrollIntoViewIfNeeded();
  assert.equal(await unavailable.getByText("Image checked", { exact: true }).count(), 0);
  await page.screenshot({ path: `${dir}/chat-image-404-win32-fixture-light-1440x920.png` });
  redMissing = false;
  await page.getByRole("button", { name: "Retry preview", exact: true }).click();
  await page.waitForFunction(() => [...document.images].some((image) => image.alt === "Generated image 1. Prompt: Red circle poster" && image.naturalWidth === 512));
  await page.getByText(/Earlier messages were summarized/).waitFor();
  assert.equal(await page.getByText(/Used in the latest response/).count(), 2);
  const redCard = page.locator(".text-generated-artifact").filter({ has: open });
  await page.setViewportSize({ width: 864, height: 576 });
  const compact = await redCard.evaluate((card) => {
    const image = card.querySelector("img").getBoundingClientRect();
    const caption = card.querySelector("figcaption").getBoundingClientRect();
    const conversation = card.closest(".text-conversation");
    const composer = document.querySelector(".text-composer").getBoundingClientRect();
    conversation.scrollTop = conversation.scrollHeight;
    const lastReply = conversation.querySelector('[data-chat-message="a-2"]').getBoundingClientRect();
    return {
      width: image.width, height: image.height, left: image.left, captionLeft: caption.left,
      scrollportGap: composer.top - conversation.getBoundingClientRect().bottom,
      replyGap: composer.top - lastReply.bottom,
    };
  });
  assert(Math.abs(compact.width - compact.height) < 1, "The compact image frame should match the square output");
  assert(Math.abs(compact.left - compact.captionLeft) < 1, "The caption should align with the actual image");
  assert(compact.scrollportGap >= 0 && compact.replyGap >= 12,
    `The last reply should clear the composer when scrolled to the bottom: ${JSON.stringify(compact)}`);
  await page.getByRole("button", { name: "Duplicate chat", exact: true }).click();
  await page.getByRole("heading", { name: "Poster (copy)", exact: true }).waitFor();
  await redCard.getByRole("button", { name: "Include this image again" }).click();
  await page.getByText("Selected for next message: Red circle poster", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Describe the poster.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(state.textRequests.length, 1);
  assert.notEqual(state.textRequests[0].threadId, "text-thread-review");
  assert.equal(state.textRequests[0].messages.at(-1).includedImage, "red-poster.png");
  assert.equal(state.textRequests[0].messages.at(-1).imageThreadId, "text-thread-review");
  assert.equal(state.textRequests[0].messages.find((message) => message.generatedImage === "red-poster.png").imageThreadId, "text-thread-review");

  const copyId = state.textRequests[0].threadId;
  const context = { size: 4096, compactedMessages: 0, images: 2, imageNames: ["green-poster.png", "red-poster.png"],
    omittedImages: 1, unavailableImages: 1, reusedImageName: "red-poster.png" };
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The current copy works.", finishedAt: Date.now() / 1000,
    result: { inputTokens: 50, outputTokens: 8, generationSeconds: 1, tokensPerSecond: 8, modelName: "Gemma",
      device: "GPU", backend: "gguf", seed: 42, temperature: 0.7, topP: 0.9, maxNewTokens: 1024, context } };
  const latestReply = page.getByRole("article", { name: "Model response" }).last();
  const contextButton = latestReply.getByRole("button", { name: "Context details", exact: true });
  const responseDetails = latestReply.getByRole("region", { name: "Response details" });
  await expect(latestReply).toContainText("The current copy works.");
  await expect(latestReply).toContainText("Some earlier images were left out of the model context.");
  await expect(latestReply).toContainText("Some earlier images were unavailable.");
  await expect(latestReply).toContainText("The selected image was included.");
  await contextButton.click();
  await expect(responseDetails).toContainText("1 earlier image was left out of the model context.");
  await expect(responseDetails).toContainText("1 earlier image was unavailable when this reply ran.");
  await expect(responseDetails).toContainText("Selected image used for this reply · Red circle poster");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === copyId)?.messages.at(-1)?.metrics?.context)
    .toEqual(context);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Poster (copy)", exact: true })).toBeVisible();
  await contextButton.click();
  await expect(responseDetails).toContainText("Selected image used for this reply · Red circle poster");
  await latestReply.getByText("The current copy works.", { exact: true }).scrollIntoViewIfNeeded();
  await expect(responseDetails).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `${dir}/chat-image-context-win32-fixture-light-1440x920.png` });
  await chooseSelectOption(page.getByLabel("Conversation versions", { exact: true }), "Early poster");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === copyId)?.messages[1]?.id)
    .toBe("archive-poster");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Poster (copy)", exact: true })).toBeVisible();
  const archivedCard = page.locator(".text-generated-artifact").filter({ has: page.getByRole("button", { name: "Review image 1: Archived poster", exact: true }) });
  await archivedCard.getByRole("button", { name: "Include this image again" }).click();
  await expect(page.getByText("Selected for next message: Archived poster", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Look at the border in the saved poster.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  const archivedRequest = state.textRequests[1];
  assert.equal(archivedRequest.threadId, copyId);
  assert.equal(archivedRequest.messages.find((message) => message.generatedImage === archivedPoster.name).imageThreadId, id);
  assert.deepEqual(archivedRequest.messages.filter((message) => message.includedImage === archivedPoster.name)
    .map((message) => message.imageThreadId), [id, id]);
  assert.deepEqual(errors, []);
  console.log("Chat image viewer, descriptive names, keyboard return, and missing-preview recovery passed.");
} finally {
  await close();
}
