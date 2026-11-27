import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-background-save";
const messages = Array.from({ length: 600 }, (_, index) => ({
  id: `saved-${index}`, role: index % 2 ? "assistant" : "user", content: `Saved note ${index + 1}.`, createdAt: index + 1,
}));
const idle = { status: "idle", id: null };
const { page, state, errors, close } = await fixture({ firstRun: true, textStatus: {
  models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
  ggufAvailable: true, supportsJobPolling: true, job: idle,
} });

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const saved = async () => (await savedTextWorkspace(page))?.threads.find((thread) => thread.id === id);
const reply = (text) => page.getByText(text, { exact: true });

async function send(prompt, requestCount) {
  await composer.fill(prompt);
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(requestCount);
  return state.textStatus.job;
}

async function finish(job, answer) {
  state.textStatus.job = { ...job, status: "complete", partialText: answer, finishedAt: Date.now() / 1000 };
  await expect(reply(answer)).toBeVisible();
}

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await expect(composer).toBeVisible();
  await expect.poll(() => savedTextWorkspace(page)).toBeTruthy();
  // Seed a version 1 database without transcript revisions, as existing profiles were saved.
  await savedTextWorkspace(page, { activeId: id, threads: [{ id, title: "Long saved chat", modelId: "local", messages }] });
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    const put = IDBObjectStore.prototype.put;
    window.transcriptWrites = { worker: [], renderer: [], received: 0, held: 0, hold: false };
    IDBObjectStore.prototype.put = function (value, ...key) {
      if (this.transaction.db.name === "fern-text-workspace" && this.name === "transcripts") {
        window.transcriptWrites.renderer.push(value.messages.length);
      }
      return put.call(this, value, ...key);
    };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const chatDatabase = String(url).includes("textThreadDatabase");
        if (chatDatabase && sessionStorage.getItem("test-disable-chat-database-worker") === "1") throw new Error("Worker blocked");
        super(url, options);
        this.chatDatabase = chatDatabase;
        if (chatDatabase) this.addEventListener("message", (event) => {
          window.transcriptWrites.received += 1;
          if (!window.transcriptWrites.hold) return;
          window.transcriptWrites.held += 1;
          event.stopImmediatePropagation();
        });
      }
      postMessage(data, ...rest) {
        if (this.chatDatabase) window.transcriptWrites.worker.push(...data.transcripts.map((change) => ({
          start: change.start, remove: change.remove, added: change.added?.length, previousCount: change.previousCount,
        })));
        return super.postMessage(data, ...rest);
      }
    };
  });
  await page.reload();
  await expect(reply("Saved note 600.")).toBeVisible();

  const first = await send("Add a new decision.", 1);
  await expect.poll(async () => (await saved())?.pendingJobId).toBe(first.id);
  assert.equal((await saved()).messages.at(-1).content, "Add a new decision.");
  await finish(first, "The first decision is recorded.");
  await expect.poll(async () => (await saved())?.messages.at(-1)?.content).toBe("The first decision is recorded.");
  const writes = await page.evaluate(() => window.transcriptWrites);
  assert.deepEqual(writes.worker, [
    { start: 600, remove: 0, added: 1, previousCount: 600 },
    { start: 601, remove: 0, added: 1, previousCount: 601 },
  ]);
  assert.deepEqual(writes.renderer, [], "Send and completion should avoid cloning all of the saved messages on the renderer");

  await expect.poll(() => page.evaluate(() => window.transcriptWrites.received)).toBe(2);
  await page.evaluate(() => { window.transcriptWrites.hold = true; });
  const next = await send("Add the follow-up decision.", 2);
  await expect.poll(() => page.evaluate(() => window.transcriptWrites.held)).toBe(1);
  const committedPrompt = await saved();
  assert.equal(committedPrompt.pendingJobId, next.id);
  assert.equal(committedPrompt.messages.length, 603);
  await finish(next, "The follow-up decision is recorded.");
  await composer.fill("Keep this unsent draft.");
  state.textStatus.job = idle;
  await page.reload();
  await expect(reply("The follow-up decision is recorded.")).toBeVisible();
  await expect(composer).toHaveValue("Keep this unsent draft.");
  const recovered = await saved();
  assert.equal(recovered.pendingJobId, null);
  assert.equal(recovered.messages.length, 604);
  assert.deepEqual(recovered.messages.slice(0, 600).map(({ id }) => id), messages.map(({ id }) => id));

  const earlierPrompt = page.getByRole("article", { name: "Your message" }).filter({ hasText: "Add a new decision." });
  await chooseMessageAction(earlierPrompt, "Delete message");
  await button("Delete").click();
  await expect.poll(async () => (await saved())?.messages.length).toBe(602);
  const deleted = await saved();
  assert.equal(deleted.messages[600].content, "Add the follow-up decision.");
  await button("Undo deletion").click();
  await expect.poll(async () => (await saved())?.messages.length).toBe(604);
  assert.deepEqual((await saved()).messages.map(({ id }) => id), recovered.messages.map(({ id }) => id));

  await page.evaluate(() => sessionStorage.setItem("test-disable-chat-database-worker", "1"));
  await page.reload();
  await expect(composer).toHaveValue("Keep this unsent draft.");
  const fallback = await send("Save even with workers unavailable.", 3);
  await expect.poll(async () => (await saved())?.pendingJobId).toBe(fallback.id);
  await finish(fallback, "The chat was saved with the fallback.");
  await expect.poll(async () => (await saved())?.messages.at(-1)?.content).toBe("The chat was saved with the fallback.");
  assert.deepEqual(await page.evaluate(() => window.transcriptWrites.renderer), [605, 606]);

  state.textStatus.job = idle;
  await page.evaluate(() => sessionStorage.removeItem("test-disable-chat-database-worker"));
  await page.reload();
  await expect(reply("The chat was saved with the fallback.")).toBeVisible();
  const newer = await savedTextWorkspace(page);
  newer.threads[0].title = "Newer saved title";
  newer.threads[0].temperature = 0.45;
  newer.threads[0].messages[1].content = "A newer save changed an earlier reply.";
  await savedTextWorkspace(page, newer);
  const olderDraft = "This edit began from an older transcript.";
  await composer.fill(olderDraft);
  await expect.poll(async () => (await saved())?.draft).toBe(olderDraft);
  assert.equal((await saved()).title, "Newer saved title");
  await send(olderDraft, 4);
  await expect(button("Retry saving chats")).toBeVisible();
  const unchanged = await saved();
  assert.equal(unchanged.title, "Newer saved title");
  assert.equal(unchanged.temperature, 0.45);
  assert.equal(unchanged.draft, olderDraft);
  assert.equal(unchanged.pendingJobId, null);
  assert.equal(unchanged.messages[1].content, "A newer save changed an earlier reply.");
  assert.equal(unchanged.messages.length, 606);
  assert.deepEqual(errors, []);
  console.log("Long chat saves recover an interrupted reply, persist delete and Undo, fall back without a worker, and protect a newer save.");
} finally {
  await close();
}
