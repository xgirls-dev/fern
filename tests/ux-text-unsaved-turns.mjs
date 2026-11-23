import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const stable = "text-thread-existing-notebook";
const id = "fern-text-turn-checkpoint:v1";
const model = { id: "local", name: "Local model", format: "gguf", installed: true };
const existingMessages = [
  { id: "recorded-prompt", role: "user", content: "What did we record?", createdAt: 1 },
  { id: "recorded-reply", role: "assistant", content: "The original answer is already saved.", status: "complete", createdAt: 2 },
];
const { page, state, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_UNSAVED_TURNS_BUILT === "1",
  textStatus: { models: [model], ggufAvailable: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: stable, threads: [{ id: stable, title: "Saved notebook", modelId: model.id, messages: existingMessages }] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const stream = page.getByRole("article", { name: "Response in progress" });
const database = (threadId) => savedTextWorkspace(page).then((workspace) => workspace?.threads.find((thread) => thread.id === threadId));
const idle = { id: null, status: "idle" };
const failWrites = () => page.evaluate(() => { window.failChatWrites = true; });
async function send(prompt, count) {
  await composer.fill(prompt);
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(count);
  return state.textStatus.job;
}

try {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === "fern-text-workspace" && window.failChatWrites) {
        throw new DOMException("Fixture write failure", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await page.reload();
  await expect(page.getByText("The original answer is already saved.", { exact: true })).toBeVisible();
  await failWrites();
  await button("New chat").click();
  const firstPrompt = "Plan the first workshop";
  const first = await send(firstPrompt, 1);
  await expect(button("Retry saving chats")).toBeVisible();
  assert.equal(await database(first.threadId), undefined);
  const partialText = "Start by inviting the organizing team.";
  state.textStatus.job = { ...first, partialText, phase: "Waiting for the first token…" };
  await expect(stream).toContainText(partialText);
  await composer.fill("An unsent follow-up in the new chat.");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  const stale = await page.evaluate((key) => localStorage.getItem(key), id);
  state.textStatus.job = { ...first, partialText: "", phase: "Waiting for the first token…" };
  await page.reload();
  await expect(page.getByRole("article", { name: "Your message" }).getByText(firstPrompt, { exact: true })).toBeVisible();
  await expect(stream).toContainText(partialText);
  await expect(composer).toHaveValue("An unsent follow-up in the new chat.");
  await expect.poll(async () => (await database(first.threadId))?.pendingJobId).toBe(first.id);
  assert.equal(state.textRequests.length, 1);

  const firstAnswer = "Invite the organizers, then choose a date.";
  state.textStatus.job = { ...first, status: "complete", partialText: firstAnswer };
  await expect(page.getByText(firstAnswer, { exact: true })).toBeVisible();
  await expect.poll(async () => (await database(first.threadId))?.messages.at(-1)?.content).toBe(firstAnswer);
  assert(stale);

  await button("Text thread: Saved notebook").click();
  await failWrites();
  const laterPrompt = "Add the second decision to the notebook.";
  const later = await send(laterPrompt, 2);
  const final = "The second decision was to start with a pilot.";
  const reasoning = "Tie the recommendation back to the first decision.";
  const result = { inputTokens: 18, outputTokens: 12, generationSeconds: 1, tokensPerSecond: 12 };
  state.textStatus.job = { ...later, status: "complete", partialText: final, partialReasoning: reasoning, result };
  await expect(page.getByText(final, { exact: true })).toBeVisible();
  await expect(button("Retry saving chats")).toBeVisible();
  assert.equal((await database(stable)).messages.length, 2);
  await composer.fill("Keep the next draft, too.");
  state.textStatus.job = idle;
  await page.reload();
  await expect(page.getByText(final, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep the next draft, too.");
  const recovered = await database(stable);
  assert.equal(recovered.pendingJobId, null);
  assert.deepEqual(recovered.messages.map((message) => message.content), [...existingMessages.map(({ content }) => content), laterPrompt, final]);
  assert.equal(recovered.messages.at(-1).reasoning, reasoning);
  assert.equal(recovered.messages.at(-1).metrics.tokensPerSecond, 12);

  await button(`Actions for text thread ${firstPrompt}`).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await button("Delete thread").click();
  await expect.poll(() => database(first.threadId)).toBeUndefined();
  await page.evaluate(({ id, stale }) => localStorage.setItem(id, stale), { id, stale });
  await page.reload();
  await expect(button(`Text thread: ${firstPrompt}`)).toHaveCount(0);
  await expect(page.getByText(final, { exact: true })).toHaveCount(1);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), id), null);

  const diskOpening = page.waitForEvent("popup");
  await page.evaluate(() => { window.open("about:blank"); });
  const disk = await diskOpening;
  const diskUrl = new URL("/fixture-chat-disk", page.url()).href;
  await disk.route(diskUrl, (route) => route.fulfill({ contentType: "text/html", body: "<title>Chat disk fixture</title>" }));
  await disk.goto(diskUrl);
  await page.bringToFront();
  for (const [index, stage] of ["blank", "pending"].entries()) {
    await failWrites();
    await button("New chat").click();
    const prompt = `Check the ${stage} close-time save.`;
    const job = await send(prompt, index + 3);
    const reply = `Recovered the reply after the ${stage} save.`;
    state.textStatus.job = { ...job, status: "complete", partialText: reply };
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await composer.fill(`Draft after the ${stage} save.`);
    const checkpoint = await page.evaluate((key) => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      return JSON.parse(localStorage.getItem(key));
    }, id);
    const captured = checkpoint.turns.find(({ thread }) => thread.id === job.threadId).thread;
    const sent = captured.messages[0];
    const saved = await savedTextWorkspace(disk);
    // Model an earlier write committing after the exit checkpoint was captured.
    await savedTextWorkspace(disk, { activeId: captured.id, threads: [{
      ...captured, draft: "", messages: stage === "pending" ? [sent] : [],
      pendingJobId: stage === "pending" ? job.id : null, updatedAt: sent.createdAt - 1,
    }, ...saved.threads] });
    state.textStatus.job = idle;
    await page.reload();
    await expect(page.getByText(reply, { exact: true })).toHaveCount(1);
    await expect(composer).toHaveValue(`Draft after the ${stage} save.`);
    assert.deepEqual((await database(job.threadId)).messages.map(({ content }) => content), [prompt, reply]);
    assert.equal((await database(job.threadId)).pendingJobId, null);
  }

  assert.deepEqual(errors, []);
  console.log("New chats and appended turns survive failed and late writes, resume existing streams, and reject stale recovery after deletion.");
} finally {
  await close();
}
