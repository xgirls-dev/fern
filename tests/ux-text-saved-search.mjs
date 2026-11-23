import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const chatId = "text-thread-saved-search";
const messages = Array.from({ length: 160 }, (_, index) => ({
  id: `row-${index}`, role: index % 2 ? "assistant" : "user", createdAt: index + 1,
  content: index % 2 ? `Reply ${index}\n\n${"Notes from the current conversation. ".repeat(8)}` : `Current prompt ${index}`,
}));
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

const { page, close, state, errors } = await fixture({
  builtRenderer: process.env.FERN_SAVED_SEARCH_BUILT === "1", firstRun: true,
  legacyTextWorkspace: { activeId: "text-thread-saved-search-other", threads: [
    { id: "text-thread-saved-search-other", title: "Other chat", modelId: "local", draft: "Keep the other draft", messages: [] },
    { id: chatId, title: "Studio notebook", modelId: "local", draft: "Keep the notebook draft", messages },
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
  await button("Search threads").click();
  const globalFind = page.getByRole("searchbox", { name: "Find a thread" });
  await globalFind.fill("hidden kiln");
  await expect(page.getByRole("dialog")).toContainText("The hidden kiln kept the sample dry.");
  await globalFind.press("Enter");
  await expect(find).toHaveValue("hidden kiln");
  await expectTarget("The hidden kiln kept the sample dry.");
  await expect.poll(() => page.evaluate(() => [...CSS.highlights.get("fern-chat-find")][0].toString())).toBe("hidden kiln");
  await expect(panel).toContainText("Try the red clay sample.");
  await expect(panel.getByRole("button", { name: "Restore this version" })).toHaveCount(0);
  await find.press("Escape");
  await expect(panel).toHaveCount(0);

  const saved = await savedTextWorkspace(page);
  assert.equal(saved.threads.find((thread) => thread.id === chatId).messages[20].promptVersionId, "edited-firing");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  const history = state.textRequests[0].messages;
  assert.equal(state.textRequests[0].threadId, chatId);
  assert(history.some((message) => message.content === "Current prompt 20"));
  assert(!history.some((message) => message.content.includes("golden cedar") || message.content.includes("red clay")));
  assert.deepEqual(errors, []);
  console.log("Saved prompts, reply variants, image descriptions, global search, virtualized navigation, and unchanged model context passed.");
} finally {
  await close();
}
