import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536 };
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" } },
});
const name = "Étage & 北 notes.txt";
const document = { id: `doc-${"a".repeat(64)}`, name, bytes: 32 };
const file = { name, mimeType: "text/plain", buffer: Buffer.from("The launch color is marigold.") };
const draft = "Keep this draft while the attachment is retried.";
const button = (name) => page.getByRole("button", { name, exact: true });
const documents = page.getByRole("list", { name: "Chat documents", exact: true });
const upload = page.locator('input[aria-label="Chat document files"]');
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const uploads = [];
let uploadError;
await page.route("**/api/text/documents", async (route) => {
  if (uploadError) return route.fulfill({ status: 400, json: { error: uploadError } });
  const request = route.request();
  assert.equal(request.headers()["content-type"], "application/octet-stream");
  uploads.push({ name: decodeURIComponent(request.headers()["x-fern-document-name"]), body: request.postDataBuffer() });
  await route.fulfill({ status: 201, json: { document } });
});

const savedChat = async () => {
  const workspace = await savedTextWorkspace(page);
  return workspace?.threads.find(({ id }) => id === workspace.activeId);
};
const savedDocuments = async () => (await savedChat())?.documents ?? [];
const interruptSaving = () => page.evaluate(() => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.transaction.db.name === "fern-text-workspace") throw new DOMException("Fixture blocks chat writes", "AbortError");
    return put.apply(this, args);
  };
});
const send = async (question, index) => {
  await composer.fill(question);
  await button("Send message").click();
  assert.equal(state.textRequests[index].messages.at(-1).content, question);
};
const complete = async (answer, sources) => {
  state.textStatus.job = {
    ...state.textStatus.job, status: "complete", partialText: answer,
    result: { inputTokens: 30, outputTokens: 12, generationSeconds: 1, tokensPerSecond: 12, documentSources: sources },
  };
  await page.getByText(answer, { exact: true }).waitFor();
};

try {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await button("Attach documents").waitFor();
  uploadError = "This document could not be opened.";
  await composer.fill(draft);
  await upload.setInputFiles(file);
  await expect(page.getByRole("alert")).toHaveText(uploadError);
  await expect(button("Refresh status")).toHaveCount(0);
  await button("Dismiss error").click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeFocused();
  uploadError = undefined;
  await expect.poll(async () => (await savedChat())?.draft).toBe(draft);
  await interruptSaving();
  await upload.setInputFiles(file);
  await documents.getByText(name, { exact: true }).waitFor();
  assert.deepEqual(uploads[0], { name, body: file.buffer });
  await expect(button("Retry saving chats")).toBeVisible();
  assert.deepEqual(await savedDocuments(), []);
  await page.reload();
  await expect(documents.getByText(name, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  assert.deepEqual(await savedDocuments(), [document]);

  const duplicateUpload = page.waitForResponse((response) => response.url().endsWith("/api/text/documents") && response.status() === 201);
  await page.evaluate((name) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["The launch color is marigold."], name, { type: "text/plain" }));
    const form = window.document.querySelector(".text-composer");
    for (const type of ["dragover", "drop"]) form.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, name);
  await duplicateUpload;
  assert.equal(uploads.length, 2);
  await button("Attach documents").waitFor();
  await page.waitForFunction(() => !window.document.querySelector(".text-composer")?.hasAttribute("data-attachment-drop"));
  assert.equal(await documents.getByRole("listitem").count(), 1);

  await send("What is the launch color?", 0);
  assert.deepEqual(state.textRequests[0].documentIds, [document.id]);
  const source = { number: 1, name, location: "Section 1", excerpt: "The launch color is marigold." };
  await complete("The launch color is marigold [1].", [source]);
  await page.getByText("Document sources", { exact: true }).click();
  await page.getByText(source.excerpt, { exact: true }).waitFor();

  await page.reload();
  await documents.getByText(name, { exact: true }).waitFor();
  await send("What's the exact color again?", 1);
  assert.deepEqual(state.textRequests[1].documentIds, [document.id]);
  await complete("Marigold.", [source]);

  await button("Duplicate chat").click();
  await documents.getByText(name, { exact: true }).waitFor();
  await expect.poll(savedDocuments).toEqual([document]);
  await interruptSaving();
  await button(`Remove ${name} from this chat`).click();
  await documents.waitFor({ state: "hidden" });
  await expect(button("Retry saving chats")).toBeVisible();
  assert.deepEqual(await savedDocuments(), [document]);
  await page.reload();
  await expect(button("Attach documents")).toBeEnabled();
  await expect(documents).toBeHidden();
  assert.deepEqual(await savedDocuments(), []);
  await send("Can you draft a short greeting?", 2);
  assert.equal(state.textRequests[2].documentIds, undefined);
  await complete("Welcome!", []);
  assert.equal(await page.getByText("Document sources", { exact: true }).count(), 2);
  assert.deepEqual(errors, []);
  console.log("Chat documents, interrupted attachment and removal saves, drag and drop, sources, and follow-ups passed.");
} finally {
  await close();
}
