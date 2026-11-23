import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const threadId = "text-thread-migrated";
const legacy = { activeId: threadId, threads: [{
  id: threadId, title: "Migrated conversation", modelId: "local", draft: "Legacy draft",
  systemPrompt: "Keep details concise.", updatedAt: 100,
  messages: [
    { id: "user", role: "user", content: "What did we agree?", createdAt: 1 },
    { id: "reply", role: "assistant", content: "Our chosen answer.", createdAt: 3, status: "complete", alternatives: [
      { id: "older", role: "assistant", content: "An earlier answer.", createdAt: 2 },
    ] },
  ],
}] };
const { page, state, errors, close } = await fixture({ firstRun: true, builtRenderer: process.env.FERN_STORAGE_BUILT === "1", legacyTextWorkspace: legacy, textStatus: {
  models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
  ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
} });

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await expect(composer).toHaveValue("Legacy draft");
  await expect(page.getByText("Our chosen answer.")).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.getItem("fern-text-threads:v1")), null);
  const migrated = await savedTextWorkspace(page);
  assert.equal(migrated.threads[0].systemPrompt, legacy.threads[0].systemPrompt);
  assert.equal(migrated.threads[0].messages[1].alternatives[0].content, "An earlier answer.");

  const longReplySize = 6 * 1024 * 1024;
  const localQuotaReached = await page.evaluate((size) => {
    try { localStorage.setItem("quota-test", "x".repeat(size)); return false; }
    catch (error) { return error.name === "QuotaExceededError"; }
    finally { localStorage.removeItem("quota-test"); }
  }, longReplySize);
  assert(localQuotaReached);
  migrated.threads[0].messages[1].alternatives[0].content = "x".repeat(longReplySize);
  await savedTextWorkspace(page, migrated);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    window.chatWrites = { transcripts: 0, metadata: 0, fail: false };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === "fern-text-workspace") {
        window.chatWrites[this.name === "transcripts" ? "transcripts" : "metadata"] += 1;
        if (window.chatWrites.fail) throw new DOMException("Fixture write failure", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await page.reload();
  await expect(composer).toHaveValue("Legacy draft");
  assert.equal((await savedTextWorkspace(page)).threads[0].messages[1].alternatives[0].content.length, longReplySize);

  await page.evaluate(() => { window.chatWrites.fail = true; });
  await composer.fill("Draft during a save failure");
  await expect(button("Retry saving chats")).toBeVisible();
  await expect(composer).toHaveValue("Draft during a save failure");
  assert.equal((await savedTextWorkspace(page)).threads[0].draft, "Legacy draft");
  await page.evaluate(() => { window.chatWrites.fail = false; });
  await button("Retry saving chats").click();
  await expect(button("Retry saving chats")).toHaveCount(0);
  assert.equal((await savedTextWorkspace(page)).threads[0].draft, "Draft during a save failure");
  const writes = await page.evaluate(() => window.chatWrites);
  assert(writes.metadata > 0, "Saving the draft should update thread metadata");
  assert.equal(writes.transcripts, 0, "Saving the draft should skip the large transcript");

  // Block writes in this page so only the small shutdown checkpoint can save the edit.
  await page.evaluate(() => { window.chatWrites.fail = true; });
  await composer.fill("Draft typed just before reload");
  await page.reload();
  await expect(composer).toHaveValue("Draft typed just before reload");
  assert.equal((await savedTextWorkspace(page)).threads[0].draft, "Draft typed just before reload");
  assert.equal(await page.evaluate(() => localStorage.getItem("fern-text-draft-checkpoint:v1")), null);

  await composer.fill("Explain what we agreed to try.");
  await button("Send message").click();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingJobId).toBeTruthy();
  const running = state.textStatus.job;
  await page.evaluate(() => { window.chatWrites.fail = true; });
  const partial = "We agreed to try a smaller batch before expanding the trial.";
  const reasoning = "First list the decisions that were already made.";
  state.textStatus.job = { ...running, phase: "Waiting for the first token…", partialText: partial, partialReasoning: reasoning };
  const stream = page.getByRole("article", { name: "Response in progress" });
  await expect(stream).toContainText(partial);
  await composer.fill("Keep this new draft alongside the response.");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingPreview).toBeUndefined();

  state.textStatus.job = { ...running, phase: "Compacting earlier turns…", partialText: "We agreed", partialReasoning: "First list" };
  await expect(stream).toContainText("Summarizing earlier messages…");
  await expect(stream).toContainText(partial);
  await page.reload();
  await expect(stream).toContainText(partial);
  await expect(composer).toHaveValue("Keep this new draft alongside the response.");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingPreview?.reasoning).toBe(reasoning);

  let recoveryRequests = 0;
  let releaseRecovery;
  let firstRecoveryReturned = false;
  await page.route("**/api/text/recover-image?*", async (route) => {
    recoveryRequests += 1;
    if (recoveryRequests === 1) {
      await new Promise((resolve) => { releaseRecovery = resolve; });
      try { await route.fulfill({ json: { image: null } }); }
      finally { firstRecoveryReturned = true; }
      return;
    }
    if (recoveryRequests === 2) return route.abort();
    return route.fulfill({ json: { image: null } });
  });
  const pausedJob = state.textStatus.job;
  state.textStatus.job = { id: null, status: "idle" };
  await expect.poll(() => typeof releaseRecovery).toBe("function");
  state.textStatus.job = pausedJob;
  await expect(stream).toContainText("Summarizing earlier messages…");
  releaseRecovery();
  await expect.poll(() => firstRecoveryReturned).toBe(true);
  state.textStatus.job = { ...pausedJob, phase: "Loading model…" };
  await expect(stream).toContainText("Loading model…");
  await expect(stream).toContainText(partial);
  await expect(page.getByText("The backend restarted. The partial response was recovered.")).toHaveCount(0);
  assert.equal((await savedTextWorkspace(page)).threads[0].pendingJobId, running.id);

  state.textStatus.job = { id: null, status: "idle" };
  await expect(stream).toContainText("Recovering response…");
  await expect.poll(() => recoveryRequests).toBe(3);
  await expect(page.getByText("The backend restarted. The partial response was recovered.")).toBeVisible();
  await expect(page.getByRole("article", { name: "Model response" }).last()).toContainText(partial);
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].messages.at(-1)?.reasoning).toBe(reasoning);
  assert.equal(await page.evaluate(() => localStorage.getItem("fern-text-draft-checkpoint:v1")), null);

  await button("Continue response").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  const continuation = state.textRequests.at(-1);
  assert.equal(continuation.messages.at(-2).content, partial);
  assert(continuation.messages.at(-1).content.endsWith(partial));
  await expect(composer).toHaveValue("Keep this new draft alongside the response.");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingJobId).toBe(continuation.requestId);
  await page.evaluate(({ threadId, oldJobId }) => {
    localStorage.setItem("fern-text-draft-checkpoint:v1", JSON.stringify({
      activeId: threadId, drafts: [], newThreads: [],
      replies: [{ id: threadId, jobId: oldJobId, preview: { content: "A checkpoint from an older response." } }],
    }));
  }, { threadId, oldJobId: running.id });
  await page.reload();
  await expect(stream).toBeVisible();
  await expect(stream).not.toContainText("A checkpoint from an older response.");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The next step is to review the trial results." };
  await expect(page.getByText("The next step is to review the trial results.")).toBeVisible();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingJobId).toBeNull();

  await button("Regenerate response").click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  const finishing = state.textStatus.job;
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingJobId).toBe(finishing.id);
  await page.evaluate(() => { window.chatWrites.fail = true; });
  const draftAfterReply = "What should I measure in the next trial?";
  await composer.fill(draftAfterReply);
  const finalAnswer = "Review the results with the team before expanding the trial.";
  const finalReasoning = "Recommend one next action based on the notes.";
  const finishedAt = Date.now() / 1000;
  const result = { outputTokens: 24, inputTokens: 45, generationSeconds: 2, tokensPerSecond: 12, modelName: "Local model" };
  state.textStatus.job = { ...finishing, status: "complete", partialText: finalAnswer, partialReasoning: finalReasoning, result, finishedAt };
  const versions = page.getByRole("group", { name: "Response versions" }).last();
  await expect(versions).toContainText("2 / 2");
  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible();
  await expect(button("Retry saving chats")).toBeVisible();
  assert.equal((await savedTextWorkspace(page)).threads[0].pendingJobId, finishing.id);

  await versions.getByRole("button", { name: "Previous response version" }).click();
  await expect(versions).toContainText("1 / 2");
  state.textStatus.job = { id: null, status: "idle" };
  await page.reload();
  await expect(versions).toContainText("1 / 2");
  await expect(page.getByText("The next step is to review the trial results.", { exact: true })).toBeVisible();
  await versions.getByRole("button", { name: "Next response version" }).click();
  await expect(page.getByText(finalAnswer, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draftAfterReply);
  await expect(versions).toContainText("2 / 2");
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].messages.at(-1)?.jobId).toBe(finishing.id);
  const recovered = (await savedTextWorkspace(page)).threads[0];
  assert.equal(recovered.pendingJobId, null);
  assert.equal(recovered.messages.at(-1).jobId, finishing.id);
  assert.equal(recovered.messages.at(-1).status, "complete");
  assert.equal(recovered.messages.at(-1).reasoning, finalReasoning);
  assert.equal(recovered.messages.at(-1).metrics.tokensPerSecond, 12);
  assert.deepEqual(recovered.messages.at(-1).alternatives.map((message) => message.jobId), [continuation.requestId]);
  assert.equal(await page.evaluate(() => localStorage.getItem("fern-text-draft-checkpoint:v1")), null);

  await page.reload();
  await expect(page.getByText(finalAnswer, { exact: true })).toHaveCount(1);
  await expect(versions).toContainText("2 / 2");

  let failedLookups = 0;
  await page.route("**/api/text/recover-image?*", (route) => {
    failedLookups += 1;
    return route.abort();
  });
  await composer.fill("What should the team do next?");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(4);
  const unfinished = state.textStatus.job;
  const savedStart = "Write down the decisions from the pilot.";
  state.textStatus.job = { ...unfinished, phase: "Generating…", partialText: savedStart };
  await expect(stream).toContainText(savedStart);
  await composer.fill("A new draft after the interrupted reply.");
  state.textStatus.job = { id: null, status: "idle" };
  await expect(stream).toContainText("Recovering response…");
  await expect(page.getByText("The response stopped, and Fern couldn’t check for saved images.", { exact: false })).toBeVisible();
  await expect(page.getByText(savedStart, { exact: true })).toBeVisible();
  assert.equal(failedLookups, 3);
  await expect(composer).toHaveValue("A new draft after the interrupted reply.");
  await expect(button("Send message")).toBeEnabled();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads[0].pendingJobId).toBeNull();

  const storage = {
    cache: { bytes: 100, fileCount: 1, retentionDays: 30, maxBytes: 1000 },
    outputs: { bytes: 0, fileCount: 0 }, images: { bytes: 0, fileCount: 0 }, audio: { bytes: 0, fileCount: 0 },
    metadata: { bytes: 0 }, models: { bytes: 1000, preservedOnReset: true },
    disk: { freeBytes: 10000, totalBytes: 20000, reserveBytes: 2000 }, managedBytes: 1100,
  };
  await page.route("**/api/storage/status", (route) => route.fulfill({ json: storage }));
  await page.route("**/api/storage/clear-local-data", (route) => route.fulfill({ json: { storage } }));
  await button("Local data").click();
  await button("Clear Local Data").click();
  await page.getByRole("group", { name: "Delete local data?" }).getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect.poll(async () => (await savedTextWorkspace(page)).threads.map((thread) => thread.id)).not.toContain(threadId);
  await expect(button("Text thread: Migrated conversation")).toHaveCount(0);
  const cleared = await savedTextWorkspace(page);
  assert.equal(cleared.threads.length, 1);
  assert.equal(cleared.threads[0].messages.length, 0);

  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    let failOnce = true;
    IDBFactory.prototype.open = function (name, ...args) {
      if (name === "fern-text-workspace" && failOnce) {
        failOnce = false;
        throw new DOMException("Fixture open failure", "UnknownError");
      }
      return open.call(this, name, ...args);
    };
  });
  await page.reload();
  await page.locator(".sidebar-new-menu > button").click();
  await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Chat history could not be opened.");
  await expect(composer).toHaveCount(0);
  await button("Retry opening chats").click();
  await expect(composer).toHaveValue("");
  assert.equal((await savedTextWorkspace(page)).activeId, cleared.activeId);
  assert.deepEqual(errors, []);
  console.log("Chat migration, draft persistence, recovery retries and live handoff, reply versions, and local data reset passed.");
} finally {
  await close();
}
