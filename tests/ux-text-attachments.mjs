import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const textModel = { id: "words", name: "Text model only", installed: true, format: "gguf" };
const visionModel = { id: "vision", name: "Vision model", installed: true, format: "gguf", supportsVision: true };
const firstId = "text-thread-attachment-first";
const secondId = "text-thread-attachment-second";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const { page, state, errors, close } = await fixture({
  builtRenderer: process.env.FERN_ATTACHMENTS_BUILT === "1", firstRun: true,
  textStatus: { models: [textModel, visionModel], ggufAvailable: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: firstId, threads: [
    { id: firstId, title: "Photo notes", modelId: textModel.id, draft: "Keep this draft", messages: [] },
    { id: secondId, title: "Second chat", modelId: textModel.id, draft: "A separate question", messages: [] },
  ] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const preview = page.getByAltText("Image to send");
const requests = [];
const imageId = (index) => `chat-image-${(index + 1).toString(16).padStart(32, "0")}.png`;
const file = (name) => ({ name, mimeType: "image/png", buffer: Buffer.from(png, "base64") });
const attach = (name) => page.getByLabel("Chat image file", { exact: true }).setInputFiles(file(name));
const open = (title) => button(`Text thread: ${title}`).click();

try {
  await page.route("**/references/chat-image-*.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  await page.route("**/api/text/images", async (route) => {
    const index = requests.length;
    const result = await new Promise((resolve) => requests.push(resolve));
    await route.fulfill(result === "error"
      ? { status: 500, json: { error: "The image could not be saved." } }
      : { status: 201, json: { image: imageId(index) } }).catch(() => {});
  });

  await expect(button("Attach chat image")).toBeEnabled();
  await composer.evaluate((input, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    for (const name of ["one.png", "two.png"]) data.items.add(new File([bytes], name, { type: "image/png" }));
    input.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(page.getByRole("alert").getByText("Attach one image per message.")).toBeVisible();
  assert.equal(requests.length, 0);
  await button("Attach chat image").focus();
  await attach("first photo.png");
  await expect(composer).toBeFocused();
  await expect(page.getByText("first photo.png", { exact: true })).toBeVisible();
  await expect(button("Send message")).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  await open("Second chat");
  await expect(button("Cancel image attachment")).toHaveCount(0);
  await expect(composer).toHaveValue("A separate question");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert.equal(state.textRequests[0].threadId, secondId);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Here is the other reply.", finishedAt: Date.now() / 1000 };
  await expect(page.getByText("Here is the other reply.")).toBeVisible();

  await open("Photo notes");
  await button("Cancel image attachment").click();
  requests[0]("ok");
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft");
  const preservedNativePaste = await composer.evaluate((input, base64) => {
    const data = new DataTransfer();
    data.setData("text/plain", "Clipboard caption");
    data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], "mixed.png", { type: "image/png" }));
    return input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  assert.equal(preservedNativePaste, true);
  await expect.poll(() => requests.length).toBe(2);
  await expect(preview).toHaveCount(0);
  requests[1]("ok");
  await expect(preview).toHaveAttribute("src", new RegExp(imageId(1)));
  await expect(button("Send message")).toBeDisabled();
  await expect(page.getByText("Choose a vision model or remove the attachment", { exact: true })).toBeVisible();
  await button("Text model: Text model only").click();
  await page.getByRole("menuitemradio", { name: "Vision model", exact: true }).click();
  await expect(button("Send message")).toBeEnabled();

  await attach("replacement.png");
  await expect.poll(() => requests.length).toBe(3);
  await button("Text model: Vision model").click();
  await page.getByRole("menuitemradio", { name: "Text model only", exact: true }).click();
  await open("Second chat");
  requests[2]("error");
  await open("Photo notes");
  await expect(page.getByRole("alert").getByText("The image could not be saved.")).toBeVisible();
  await expect(preview).toHaveAttribute("src", new RegExp(imageId(1)));
  await open("Second chat");
  await expect(page.getByRole("alert").getByText("The image could not be saved.")).toHaveCount(0);
  await open("Photo notes");
  await button("Retry image attachment").click();
  await expect(composer).toBeFocused();
  await expect.poll(() => requests.length).toBe(4);
  await button("Text model: Text model only").click();
  await page.getByRole("menuitemradio", { name: "Vision model", exact: true }).click();
  requests[3]("ok");
  await expect(preview).toHaveAttribute("src", new RegExp(imageId(3)));
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === firstId)?.draftImage).toBe(imageId(3));
  await page.reload();
  await expect(preview).toHaveAttribute("src", new RegExp(imageId(3)));
  await expect(composer).toHaveValue("Keep this draft");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.equal(state.textRequests[1].threadId, firstId);
  assert.equal(state.textRequests[1].messages.at(-1).image, imageId(3));
  await button("New chat").click();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.length).toBe(3);
  const pendingId = (await savedTextWorkspace(page)).activeId;
  await expect(composer).toHaveValue("");
  await attach("background.png");
  await expect.poll(() => requests.length).toBe(5);
  await button("New chat").click();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.length).toBe(4);
  await expect(button("Cancel image attachment")).toHaveCount(0);
  requests[4]("ok");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === pendingId)?.draftImage).toBe(imageId(4));
  await expect(preview).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Attachment drafting, mixed paste, per-chat upload and cancellation, retry, model switching, persistence, and send passed.");
} finally {
  requests.forEach((resolve) => resolve("ok"));
  await close();
}
