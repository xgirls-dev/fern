import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const notebook = "text-thread-workshop-notebook";
const reference = "text-thread-reference-notes";
const title = "Workshop notebook";
const original = "Oxide **glaze** sample.";
const revised = "Record the kiln schedule.";
const final = "The next burn uses the **juniper** setting.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  legacyTextWorkspace: { activeId: notebook, threads: [
    { id: notebook, title, modelId: "local", draft: "Keep this separate draft.", messages: [
      { id: "question", role: "user", content: "Describe the glaze.", createdAt: 1 },
      { id: "answer", role: "assistant", content: original, createdAt: 2 },
    ] },
    { id: reference, title: "Reference notes", modelId: "local", messages: [
      { id: "reference-note", role: "user", content: "The brass template goes in the cabinet.", createdAt: 3 },
    ] },
  ] },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const dialog = page.getByRole("dialog", { name: "Search threads", exact: true });
const field = dialog.getByRole("searchbox", { name: "Find a thread", exact: true });
const result = (title) => dialog.getByRole("button").filter({ hasText: title });
const noMatches = dialog.getByRole("status").filter({ hasText: "No matching threads" });
const searching = dialog.getByRole("status").filter({ hasText: "Searching chat messages" });
const prompt = page.getByRole("log", { name: "Conversation" }).locator('[data-chat-message="question"]');
const workerUpdates = () => page.evaluate(() => window.searchUpdates);
const searchWorkers = () => page.workers().filter((worker) =>
  /\/(?:assets\/threadSearch\.worker-[^/]+\.js|src\/lib\/threadSearch\.worker\.ts)(?:\?.*)?$/.test(worker.url()));
const openSearch = async (query) => {
  await button("Search threads").click();
  await field.fill(query);
};
const closeSearch = async () => {
  await field.press("Escape");
  await expect(dialog).toHaveCount(0);
};

const trackWorkers = () => page.evaluate(() => {
  window.searchUpdates = [];
  window.closedSearchWorkers = 0;
  const workers = new WeakSet();
  const send = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...options) {
    if (typeof message?.query === "string") {
      workers.add(this);
      window.searchUpdates.push({ query: message.query,
        updated: message.updated.map(({ id }) => id).sort(), removed: [...message.removed].sort() });
    }
    return Reflect.apply(send, this, [message, ...options]);
  };
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function () {
    if (workers.has(this)) window.closedSearchWorkers++;
    return Reflect.apply(terminate, this, []);
  };
});

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await trackWorkers();

  assert.equal(searchWorkers().length, 0, "Boot should leave the search worker unloaded");
  await button("Search threads").click();
  await expect(field).toBeFocused();
  await expect.poll(() => searchWorkers().length).toBe(1);
  assert.deepEqual(await workerUpdates(), [], "Opening search should leave chat history in the renderer");
  await field.fill("oxide glaze sample");
  await expect(result(title)).toContainText("Oxide glaze sample.");
  assert.deepEqual((await workerUpdates()).at(-1).updated, [reference, notebook].sort());
  assert(await savedTextWorkspace(page), "Search should use the migrated chat workspace.");
  await closeSearch();

  await openSearch("brass template");
  await expect(result("Reference notes")).toContainText("brass template");
  await expect(searching).toHaveCount(0);
  assert.deepEqual((await workerUpdates()).at(-1).updated, [], "Reopening search should keep unchanged histories indexed");
  await closeSearch();

  await prompt.getByRole("button", { name: "Edit message", exact: true }).click();
  await page.getByRole("textbox", { name: "Edited prompt", exact: true }).fill(revised);
  await button("Send revision").click();
  await expect(prompt).toContainText(revised);
  await openSearch("juniper setting");
  await expect(noMatches).toBeVisible();
  assert.deepEqual((await workerUpdates()).at(-1).updated, [notebook]);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: final, finishedAt: Date.now() / 1000 };
  await expect(result(title)).toContainText("juniper setting");
  assert.deepEqual((await workerUpdates()).at(-1).updated, [notebook], "The pending search should refresh when the reply settles");

  await field.fill("oxide glaze sample");
  await expect(result(title)).toContainText("Oxide glaze sample.");
  await field.press("Enter");
  const find = page.getByRole("searchbox", { name: "Search this chat", exact: true });
  await expect(find).toHaveValue("oxide glaze sample");
  await expect(page.getByRole("region", { name: "Prompt versions" })).toContainText("Oxide glaze sample.");
  await find.press("Escape");
  await expect(prompt).toContainText(revised);

  await chooseMessageAction(prompt, "Delete message");
  await page.getByRole("group", { name: "Confirm message deletion" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await openSearch("juniper setting");
  await expect(noMatches).toBeVisible();
  assert.deepEqual((await workerUpdates()).at(-1).removed, [notebook]);
  await field.press("Enter");
  await expect(field).toBeFocused();
  await field.fill("brass template");
  await expect(result("Reference notes")).toBeVisible();
  await expect(searching).toHaveCount(0);
  assert.deepEqual((await workerUpdates()).at(-1).updated, [], "Removing a chat index should keep other chats warm");
  await closeSearch();

  await button("Undo deletion").click();
  await expect(prompt).toContainText(revised);
  await openSearch("juniper setting");
  await expect(result(title)).toContainText("juniper setting");
  assert.deepEqual((await workerUpdates()).at(-1).updated, [notebook]);
  await closeSearch();

  await page.reload();
  await trackWorkers();
  await openSearch("juniper setting");
  await expect(result(title)).toBeVisible();
  await field.press("Enter");
  await expect(find).toHaveValue("juniper setting");
  await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString())).toBe("juniper setting");
  await find.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this separate draft.");

  const storage = {
    outputs: { bytes: 0, fileCount: 0 }, images: { bytes: 0, fileCount: 0 }, audio: { bytes: 0, fileCount: 0 },
    metadata: { bytes: 0 }, models: { bytes: 0, preservedOnReset: true },
    cache: { bytes: 0, fileCount: 0 }, disk: { freeBytes: 10000, totalBytes: 20000, reserveBytes: 2000 }, managedBytes: 0,
  };
  await page.route("**/api/storage/status", (route) => route.fulfill({ json: storage }));
  await page.route("**/api/storage/clear-local-data", (route) => route.fulfill({ json: { storage } }));
  await button("Local data").click();
  await button("Clear Local Data").click();
  await page.getByRole("group", { name: "Delete local data?" }).getByRole("button", { name: "Delete local data", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.closedSearchWorkers)).toBe(1);
  await openSearch("juniper setting");
  await expect(noMatches).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Thread search keeps unchanged chats warm and refreshes after revision, background completion, deletion, Undo, relaunch, and reset.");
} finally {
  await close();
}
