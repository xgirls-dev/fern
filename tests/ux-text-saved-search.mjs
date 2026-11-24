import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const chatId = "text-thread-saved-search";
const messages = Array.from({ length: 160 }, (_, index) => ({
  id: `row-${index}`, role: index % 2 ? "assistant" : "user", createdAt: index + 1,
  content: index % 2 ? `Reply ${index}\n\n${"Notes from the current conversation. ".repeat(8)}` : `Current prompt ${index}`,
}));
const markdownMatches = [
  { source: "The **crystal** lattice is stable.", query: "crystal lattice", displayed: "crystal lattice" },
  { source: "The &#90;ircon is luminous.", query: "zircon is luminous", displayed: "Zircon is luminous" },
  { source: "[^sample]: The relocated **footnote**\n\nThe sample marker[^sample].",
    query: "sample marker1. the relocated footnote", displayed: "The relocated footnote" },
  { source: "The **Kelvin** ſcale is stable.", query: "kelvin scale", displayed: "Kelvin ſcale" },
  { source: "Read the **結晶** 格子 findings.", query: "結晶 格子", displayed: "結晶 格子" },
];
for (const [index, { source }] of markdownMatches.entries()) {
  messages[35 + index * 2].content = source;
}

messages[20].promptVersionId = "edited-firing";
messages[20].promptAlternatives = [
  { id: "first-firing", content: "Find the golden cedar glaze", createdAt: 3,
    response: { id: "original-answer", role: "assistant", content: "The selected answer used oak ash.", createdAt: 8,
      alternatives: [{ id: "previous-answer", role: "assistant", content: "Try the red clay sample.", createdAt: 4,
        reasoning: `${Array.from({ length: 40 }, (_, index) => `Testing note ${index + 1} came before the final observation.`).join("\n\n")}\n\nThe hidden kiln kept the sample dry.`,
      }],
    } },
  { id: "second-firing", content: "Find a different glaze", createdAt: 9,
    response: { id: "second-answer", role: "assistant", content: "Use the golden cedar test tile.", createdAt: 10,
      generatedImage: { name: "tile.png", prompt: "A pattern of tiny stars", modelLabel: "Local model", width: 256, height: 256 },
    } },
];

const snapshot = {
  id: "earlier-draft",
  label: "Kiln workshop",
  messages: Array.from({ length: 160 }, (_, index) => ({
    id: `snapshot-${index}`, role: index % 2 ? "assistant" : "user", createdAt: index + 1,
    content: index % 2 ? `Saved reply ${index}` : `Saved prompt ${index}`,
  })),
};
Object.assign(snapshot.messages[141], {
  content: "The **opal** arch survived firing.",
  generatedImage: { name: "tile.png", prompt: "The old tiled kiln", modelLabel: "Local model", width: 256, height: 256 },
});

const { page, close, state, errors } = await fixture({
  builtRenderer: process.env.FERN_SAVED_SEARCH_BUILT === "1", firstRun: true,
  legacyTextWorkspace: { activeId: "text-thread-saved-search-other", threads: [
    { id: "text-thread-saved-search-other", title: "Other chat", modelId: "local", draft: "Keep the other draft", messages: [] },
    { id: chatId, title: "Studio notebook", modelId: "local", draft: "Keep the notebook draft", messages, versions: [snapshot] },
  ] },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }], ggufAvailable: true, job: { id: null, status: "idle" } },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const feed = page.getByRole("log", { name: "Conversation" });
const row = feed.locator('[data-chat-message="row-20"]');
const panel = row.getByRole("region", { name: "Prompt versions" });
const target = panel.locator("[data-find-target]");
const find = page.getByRole("searchbox", { name: "Search this chat" });
const findbar = page.getByRole("search", { name: "Find in chat" });
const parserUrl = /\/(?:assets\/chatSearch-[^/]+\.js|src\/lib\/chatSearch\.ts)(?:\?.*)?$/;
const workerUrl = /\/(?:assets\/threadSearch\.worker-[^/]+\.js|src\/lib\/threadSearch\.worker\.ts)(?:\?.*)?$/;
const workerGate = Promise.withResolvers();

async function expectTarget(text) {
  await expect(row).toHaveAttribute("data-find-match", "true");
  await expect(panel).toBeVisible();
  await expect(target).toContainText(text);
  await expect.poll(() => target.evaluate((element) => {
    const range = [...(CSS.highlights.get("fern-chat-find") ?? [])][0];
    if (!range) return false;
    const hit = range.getClientRects()[0];
    const visible = element.closest(".text-conversation").getBoundingClientRect();
    return hit.top >= visible.top - 1 && hit.top < visible.bottom;
  })).toBe(true);
}

try {
  await page.route("**/outputs/tile.png*", (route) => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#71978a"/></svg>' }));
  assert.equal(await page.evaluate((patterns) => performance.getEntriesByType("resource")
    .some(({ name }) => patterns.some((pattern) => new RegExp(pattern).test(name))), [parserUrl.source, workerUrl.source]),
    false, "Chat should open without loading search code");
  await button("Text thread: Studio notebook").click();
  await expect(row).toHaveCount(0);
  await button("Find in chat").click();
  await find.fill("golden cedar");
  await expect(findbar.getByRole("status")).toContainText("1 of 2");
  await expectTarget("Find the golden cedar glaze");
  await expect(find).toBeFocused();
  await find.press("Enter");
  await expect(findbar.getByRole("status")).toContainText("2 of 2");
  await expectTarget("Use the golden cedar test tile.");
  await find.press("Shift+Enter");
  await expectTarget("Find the golden cedar glaze");
  await find.fill("tiny stars");
  await expectTarget("A pattern of tiny stars");
  await find.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("fern-chat-find"))).toBe(false);
  await expect(row.locator(".text-user-bubble > .text-message-content")).toHaveText("Current prompt 20");
  await expect(composer).toHaveValue("Keep the notebook draft");

  const versions = row.getByRole("button", { name: "Prompt versions", exact: true });
  await versions.press("Enter");
  const earlierVersion = panel.getByRole("combobox", { name: "Earlier prompt version" });
  await earlierVersion.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(earlierVersion).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(versions).toBeFocused();

  await row.getByRole("button", { name: "Edit message", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edited prompt" });
  await editor.fill("An unsent prompt edit");
  await button("Find in chat").click();
  await find.fill("golden cedar");
  await expectTarget("Find the golden cedar glaze");
  await find.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(editor).toHaveValue("An unsent prompt edit");
  await editor.press("Escape");

  await button("Text thread: Other chat").click();
  await page.reload();
  await expect(composer).toHaveValue("Keep the other draft");
  await page.evaluate(() => {
    window.sentThreadQueries = [];
    window.threadSearchCancellations = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...options) {
      if (typeof message?.query === "string") window.sentThreadQueries.push(message.query);
      if (typeof message?.cancel === "number") window.threadSearchCancellations++;
      return Reflect.apply(send, this, [message, ...options]);
    };
  });
  const sentQueries = () => page.evaluate(() => window.sentThreadQueries);
  let workerRequested = false;
  await page.route(workerUrl, async (route) => {
    workerRequested = true;
    await workerGate.promise;
    await route.continue();
  });
  await button("Search threads").click();
  const globalFind = page.getByRole("searchbox", { name: "Find a thread" });
  await globalFind.fill("Studio notebook");
  await expect.poll(() => workerRequested, { timeout: 10_000 }).toBe(true);
  await expect(page.locator(".thread-browser-open").filter({ hasText: "Studio notebook" })).toBeVisible();
  await globalFind.press("Enter");
  await globalFind.fill("hidden");
  await globalFind.fill("hidden kiln");
  await expect(page.getByRole("status").filter({ hasText: "Searching chat messages" })).toBeVisible();
  await globalFind.press("Enter");
  await expect(globalFind).toBeFocused();
  assert.deepEqual(await sentQueries(), ["Studio notebook"], "Do not queue obsolete searches while the worker is busy");
  assert.equal(await page.evaluate(() => window.threadSearchCancellations), 1, "Interrupt the obsolete search once");
  workerGate.resolve();
  await expect(find).toHaveValue("hidden kiln");
  assert.deepEqual(await sentQueries(), ["Studio notebook", "hidden kiln"]);
  await expectTarget("The hidden kiln kept the sample dry.");
  await expect.poll(() => page.evaluate(() => [...CSS.highlights.get("fern-chat-find")][0].toString())).toBe("hidden kiln");
  await expect(panel).toContainText("Try the red clay sample.");
  await expect(panel.getByRole("button", { name: "Restore this version" })).toHaveCount(0);
  await find.press("Escape");
  await expect(panel).toHaveCount(0);

  await button("Search threads").click();
  const notebook = page.locator(".thread-browser-open").filter({ hasText: "Studio notebook" });
  for (const { query, displayed } of markdownMatches) {
    await globalFind.fill(query);
    await expect(notebook).toContainText(displayed);
  }
  await globalFind.fill("crystal stable lattice");
  await expect(page.getByRole("status", { name: "" }).filter({ hasText: "No matching threads" })).toBeVisible();

  await globalFind.fill("opal arch");
  await expect(notebook).toContainText("opal arch");
  await expect(notebook).toContainText("Saved version");
  await globalFind.press("Enter");
  const preview = page.getByRole("dialog", { name: "Saved conversation", exact: true });
  await expect(preview).toContainText("Studio notebook · Kiln workshop");
  const previewFind = preview.getByRole("searchbox", { name: "Search this chat" });
  await expect(previewFind).toHaveValue("opal arch");
  const savedFeed = preview.getByRole("log", { name: "Saved conversation messages", exact: true });
  assert(await savedFeed.evaluate((element) => getComputedStyle(element).getPropertyValue("--chat-action").trim()),
    "The saved conversation should use the chat match highlight color.");
  await expect.poll(() => savedFeed.evaluate((element) => element.clientHeight)).toBeGreaterThan(300);
  await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString()))
    .toBe("opal arch");
  assert(await preview.locator("[data-chat-message]").count() < snapshot.messages.length,
    "The saved conversation should keep distant rows deferred.");
  await previewFind.fill("old tiled kiln");
  await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString()))
    .toBe("old tiled kiln");
  await preview.getByRole("button", { name: "Back to search", exact: true }).click();
  await expect(globalFind).toHaveValue("opal arch");
  await expect(globalFind).toBeFocused();
  await globalFind.press("Escape");
  await expect(button("Search threads")).toBeFocused();
  await expect(composer).toHaveValue("Keep the notebook draft");

  const saved = await savedTextWorkspace(page);
  assert.equal(saved.threads.find((thread) => thread.id === chatId).messages[20].promptVersionId, "edited-firing");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  const history = state.textRequests[0].messages;
  assert.equal(state.textRequests[0].threadId, chatId);
  assert(history.some((message) => message.content === "Current prompt 20"));
  assert(!history.some((message) => ["golden cedar", "red clay", "opal"].some((term) => message.content.includes(term))));
  assert.deepEqual(errors, []);
  console.log("Saved prompts, reply variants, image descriptions, global search, virtualized navigation, and unchanged model context passed.");
} finally {
  workerGate.resolve();
  await close();
}
