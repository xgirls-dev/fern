import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-context-notes";
const attachment = "chat-image-0123456789abcdef0123456789abcdef.png";
const oldTurns = Array.from({ length: 316 }, (_, index) => ({
  id: `row-${index}`, role: index % 2 ? "assistant" : "user", content: `Notebook message ${index}.`, createdAt: index + 1,
}));
const excludedReply = `Deep archive. ${"Earlier research note. ".repeat(4200)}`.trimEnd();
oldTurns[1].content = excludedReply;
const longPrompt = "A prior prompt. ".repeat(1500).trim();
const replyPrefix = `${"A prior answer. ".repeat(1250).slice(0, 19_999)}💡`;
const longReply = `${replyPrefix} ${"Context beyond the cutoff. ".repeat(200)}`.trimEnd();
const messages = [...oldTurns,
  { id: "long-user", role: "user", content: longPrompt, image: attachment, createdAt: 321 },
  { id: "long-reply", role: "assistant", content: longReply, createdAt: 322 },
  { id: "unanswered", role: "user", content: "An unanswered question.", createdAt: 323 },
  { id: "failed", role: "assistant", content: "", status: "failed", error: "Generation stopped before the answer.", createdAt: 324 },
];

const { page, state, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_CONTEXT_BUILT === "1", viewport: { width: 1150, height: 775 },
  legacyTextWorkspace: { activeId: id, threads: [
    { id, title: "The long notebook", modelId: "local", contextSize: 4096, maxNewTokens: 8192, messages },
    { id: "text-thread-oversized-current", title: "Oversized current prompt", modelId: "openvino",
      messages: [{ id: "oversized-current", role: "user", content: longPrompt, createdAt: 1 }] },
  ] },
  textStatus: { models: [{ name: "Local model", id: "local", format: "gguf", installed: true }, { name: "OpenVINO model", id: "openvino", format: "openvino", installed: true }], ggufAvailable: true, runtimeAvailable: true, job: { status: "idle", id: null } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const feed = page.getByRole("log", { name: "Conversation" });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const details = feed.getByRole("region", { name: "Response details" });
const saved = async () => (await savedTextWorkspace(page))?.threads.find((thread) => thread.id === id);
const metrics = { inputTokens: 1773, outputTokens: 16, generationSeconds: 1, tokensPerSecond: 16, maxNewTokens: 2048,
  context: { size: 4096, compactedMessages: 12, images: 0 } };

try {
  await page.route(`**/references/${attachment}`, (route) => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#496d59"/></svg>' }));
  // An unrelated write is still active when the follow-up reaches the model API.
  await page.evaluate((archived) => new Promise((resolve, reject) => {
    const originalIterator = String.prototype[Symbol.iterator];
    window.archivedReplyIterations = 0;
    String.prototype[Symbol.iterator] = function () {
      if (String(this) === archived) window.archivedReplyIterations += 1;
      return originalIterator.call(this);
    };
    const open = indexedDB.open("fern-text-workspace");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      window.chatWriteHeld = true;
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      const keepOpen = () => {
        store.get("header").onsuccess = () => {
          if (window.chatWriteHeld) keepOpen();
          resolve();
        };
      };
      keepOpen();
    };
  }), excludedReply);
  await composer.fill("Bring the notebook up to date.");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert(await page.evaluate(() => window.chatWriteHeld));
  assert.equal(await page.evaluate(() => window.archivedReplyIterations), 0, "Do not shorten a reply outside the request window");
  await page.evaluate(() => { window.chatWriteHeld = false; });
  const sent = state.textRequests[0].messages;
  assert.equal(sent.length, 313);
  assert.equal(sent[0].content, "Notebook message 6.");
  assert.equal(sent.at(-3).content.length, 20_000);
  assert.equal(sent.at(-3).image, undefined);
  assert.equal(sent.at(-2).content, replyPrefix);
  assert.equal(sent.at(-1).content, "Bring the notebook up to date.");
  assert(!sent.some((message) => message.content === "An unanswered question."));
  await expect.poll(async () => (await saved())?.pendingContext?.omittedMessages).toBe(6);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(feed.getByRole("article", { name: "Response in progress" })).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The notebook is up to date.", result: metrics, finishedAt: Date.now() / 1000 };
  const reply = feed.getByRole("article", { name: "Model response" }).last();
  await expect(reply).toContainText("The notebook is up to date.");
  await expect(reply).toContainText("Some earlier messages were left out.");
  await expect(reply).toContainText("Earlier messages were summarized");
  await reply.getByRole("button", { name: "Context details", exact: true }).click();
  await expect(details).toContainText("6 earlier messages were left out of the request.");
  await expect(details).toContainText("2 long messages were shortened in the request.");
  await expect(details).toContainText("1 unanswered prompt was left out of the request.");
  await expect(details).toContainText("1 earlier image attachment was left out of the request.");
  await expect(details).toContainText("12 earlier messages were summarized by the model.");
  await expect(details).toContainText("4,096 token context");
  assert(await details.evaluate((panel) => !!(panel.compareDocumentPosition(panel.closest("article").querySelector(".text-message-content")) & Node.DOCUMENT_POSITION_FOLLOWING)),
    "The details opened from the context notice should appear before the reply text");
  await expect.poll(async () => (await saved())?.messages.at(-1)?.requestContext?.shortenedMessages).toBe(2);
  assert.equal((await saved()).messages.find((message) => message.id === "long-user").content, longPrompt);
  assert.equal((await saved()).messages.find((message) => message.id === "long-reply").content, longReply);
  assert.equal((await saved()).messages.find((message) => message.id === "row-1").content, excludedReply);

  await button("Chat settings").click();
  const settings = page.getByRole("complementary", { name: "Chat settings panel" });
  await expect(settings.getByRole("spinbutton", { name: "Maximum output (tokens)" })).toHaveValue("4096");
  await settings.getByRole("spinbutton", { name: "Context length (tokens)" }).fill("16384");
  await expect(settings.getByRole("spinbutton", { name: "Maximum output (tokens)" })).toHaveValue("8192");
  await settings.getByRole("button", { name: "Close chat settings" }).click();
  await composer.fill("What should I remember next?");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  const second = state.textRequests.at(-1);
  assert.equal(second.contextSize, 16384);
  assert.equal(second.messages.length, 299, "Advance the window after it reaches its limit");
  assert.equal(second.messages[0].content, "Notebook message 22.");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Remember the last entry.",
    result: { ...metrics, context: { ...metrics.context, size: 16384, compactedMessages: 0 } }, finishedAt: Date.now() / 1000 };
  await expect(reply).toContainText("Remember the last entry.");
  await expect(reply.getByRole("button", { name: "Context details", exact: true })).toHaveCount(0);
  await chooseMessageAction(reply, "Response details");
  await expect(reply.getByRole("region", { name: "Response details" })).toContainText("22 earlier messages were left out of the request.");
  await composer.fill("Which notes should stay on the agenda?");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  const third = state.textRequests.at(-1);
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages,
    "Keep the complete retained prompt prefix when a follow-up is within the same window");
  assert.equal(third.messages.length, second.messages.length + 2);
  assert.equal(third.messages.at(-1).content, "Which notes should stay on the agenda?");
  await expect.poll(async () => (await saved())?.pendingContext?.omittedMessages).toBe(22);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "Keep the most recent notes.", finishedAt: Date.now() / 1000 };
  await expect(reply).toContainText("Keep the most recent notes.");
  await button("Text thread: Oversized current prompt").click();
  await button("Retry response").click();
  await expect(page.getByRole("alert")).toContainText("The current prompt exceeds 20,000 characters. Edit it before sending.");
  assert.equal(state.textRequests.length, 3);
  await expect(feed.getByRole("article", { name: "Your message" })).toHaveText(/^A prior prompt/);
  assert.deepEqual(errors, []);
  console.log("Request limits preserve the stored transcript and report omitted, shortened, and summarized history per response.");
} finally {
  await page.evaluate(() => { window.chatWriteHeld = false; }).catch(() => {});
  await close();
}
