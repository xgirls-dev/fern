import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const id = "text-thread-find-occurrences";
const paragraphs = (topic) => Array.from({ length: 32 }, (_, i) => `${topic} ${i + 1} fills part of the reply.`).join("\n\n");
const messages = Array.from({ length: 156 }, (_, i) => ({
  id: `row-${i}`, role: i % 2 ? "assistant" : "user", content: `Archive note ${i}.`, createdAt: i + 1,
}));
messages[31].content = [
  paragraphs("First section"), "First sighting: **quiet** cedar beside the path.",
  paragraphs("Second section"), "Second sighting: quiet cedar above the valley.",
  paragraphs("Third section"), "Third sighting: Quiet **cedar** near the cottage.",
  "First spelling: one **cafe**\u0301 quente, please.",
  "Second spelling: one café quente, please.",
  "Plain spelling: one cafe quente, please.",
  "Korean spelling: \u1100\u1161\u11a8 sample.",
  "[Details](https://example.com/invisible-needle)",
  `\x60\x60\x60text\n${"gutter ".repeat(130)}wide-code-needle\n\x60\x60\x60`,
].join("\n\n");
messages[31].reasoning = `${paragraphs("Observation")}\n\nReasoning also mentions quiet cedar.`;
messages[31].generatedImage = { name: "forest.png", prompt: "An evergreen illustration", width: 256, height: 256, modelLabel: "Local model" };
messages[31].generatedImages = [messages[31].generatedImage,
  { ...messages[31].generatedImage, name: "river.png", prompt: "A river illustration at dusk" }];

const { page, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_FIND_BUILT === "1", viewport: { width: 1050, height: 680 },
  legacyTextWorkspace: { activeId: id, threads: [{ id, title: "E\u0301te\u0301 Forest notebook", draft: "Keep the next draft", modelId: "local", messages }] },
  textStatus: { models: [{ name: "Local model", id: "local", format: "gguf", installed: true }], ggufAvailable: true, job: { status: "idle", id: null } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const row = page.locator('[data-chat-message="row-31"]');
const search = page.getByRole("searchbox", { name: "Search this chat" });
const count = page.getByRole("search", { name: "Find in chat" }).getByRole("status");
const highlightedText = () => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString());

async function activeHit(start) {
  await expect.poll(() => row.evaluate((article) => {
    const range = [...(CSS.highlights.get("fern-chat-find") ?? [])][0];
    const line = range?.getClientRects()[0];
    const view = article.closest(".text-conversation").getBoundingClientRect();
    if (!line || line.top < view.top || line.bottom > view.bottom) return "outside the conversation viewport";
    return range.startContainer.parentElement.closest("p")?.textContent;
  })).toContain(start);
  await expect(search).toBeFocused();
}

try {
  await page.route(/\/outputs\/(forest|river)\.png/, (route) => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#496d59"/></svg>' }));
  await expect(row).toHaveCount(0);
  await button("Find in chat").click();
  await page.evaluate(() => {
    const getRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
      if (this.toString() === "quiet cedar" && this.startContainer.parentElement?.closest("p")?.textContent.startsWith("First sighting")) {
        Range.prototype.getClientRects = getRects;
        window.firstFindLayoutDeferred = true;
        return [];
      }
      return getRects.call(this);
    };
  });
  await search.fill("quiet cedar");
  await expect(count).toHaveText("1 of 4");
  await activeHit("First sighting");
  assert.equal(await page.evaluate(() => window.firstFindLayoutDeferred), true);
  await search.press("Enter");
  await expect(count).toHaveText("2 of 4");
  await activeHit("Second sighting");
  await search.press("Enter");
  await expect(count).toHaveText("3 of 4");
  await activeHit("Third sighting");
  await search.press("Enter");
  await expect(count).toHaveText("4 of 4");
  await activeHit("Reasoning also mentions");
  await expect(row.locator("details")).toHaveAttribute("open", "");
  await search.press("Enter");
  await expect(count).toHaveText("1 of 4");
  await activeHit("First sighting");
  await expect(row.locator("details")).not.toHaveAttribute("open", "");
  await search.press("Shift+Enter");
  await activeHit("Reasoning also mentions");
  await search.press("Escape");
  await expect(row.locator("details")).not.toHaveAttribute("open", "");
  await expect(button("Find in chat")).toBeFocused();

  await button("Find in chat").click();
  await search.fill("invisible-needle");
  await expect(count).toHaveText("No matches");
  await search.fill("wide-code-needle");
  await expect(count).toHaveText("1 of 1");
  await expect.poll(() => row.locator("pre").evaluate((code) => {
    const range = [...(CSS.highlights.get("fern-chat-find") ?? [])][0];
    const hit = range?.getBoundingClientRect();
    const viewport = code.closest(".text-conversation").getBoundingClientRect();
    const box = code.getBoundingClientRect();
    return !!hit && hit.left >= box.left && hit.right <= box.right && hit.top >= viewport.top && hit.bottom <= viewport.bottom;
  })).toBe(true);
  await search.fill("evergreen illustration");
  await expect(count).toHaveText("1 of 1");
  await activeHit("An evergreen illustration");
  await search.fill("illustration");
  await expect(count).toHaveText("1 of 2");
  await activeHit("An evergreen illustration");
  await search.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await activeHit("A river illustration at dusk");
  await expect.poll(() => row.locator("[data-find-target]").evaluate((caption) => {
    const image = caption.closest("figure").querySelector("img");
    return image.getBoundingClientRect().top - caption.closest(".text-conversation").getBoundingClientRect().top;
  })).toBeGreaterThanOrEqual(-1);
  await search.press("Shift+Enter");
  await activeHit("An evergreen illustration");
  await search.press("Escape");
  await expect(row.getByText("An evergreen illustration", { exact: true })).toHaveCount(0);

  await button("Search threads").click();
  const threads = page.getByRole("searchbox", { name: "Find a thread" });
  await threads.fill("river illustration at dusk");
  await expect(page.getByRole("dialog")).toContainText("A river illustration at dusk");
  await threads.press("Enter");
  await activeHit("A river illustration at dusk");
  await search.press("Escape");

  await button("Search threads").click();
  await threads.fill("invisible-needle");
  await expect(page.getByText("No matching threads")).toBeVisible();
  await threads.fill("quiet cedar beside the path");
  await expect(page.getByRole("dialog")).toContainText("First sighting: quiet cedar beside the path.");
  await threads.press("Enter");
  await activeHit("First sighting");
  await search.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep the next draft");

  await button("Find in chat").click();
  await search.fill("CAFÉ quente");
  await expect(count).toHaveText("1 of 2");
  await activeHit("First spelling");
  await expect.poll(highlightedText).toBe("cafe\u0301 quente");
  await search.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await activeHit("Second spelling");
  await expect.poll(highlightedText).toBe("café quente");
  await search.fill("cafe quente");
  await expect(count).toHaveText("1 of 1");
  await activeHit("Plain spelling");
  await search.fill("각 sample");
  await expect(count).toHaveText("1 of 1");
  await activeHit("Korean spelling");
  await expect.poll(highlightedText).toBe("\u1100\u1161\u11a8 sample");
  await search.press("Escape");

  await button("Search threads").click();
  await threads.fill("cafe\u0301 quente");
  await expect(page.getByRole("dialog")).toContainText("First spelling: one cafe\u0301 quente, please.");
  await threads.press("Enter");
  await expect(count).toHaveText("1 of 2");
  await expect.poll(highlightedText).toBe("cafe\u0301 quente");
  await search.press("Escape");
  await button("Search threads").click();
  await threads.fill("ÉTÉ FOREST");
  await expect(page.getByRole("dialog").getByRole("button", { name: /Forest notebook/ })).toBeVisible();
  await threads.press("Escape");

  assert.deepEqual(errors, []);
  console.log("Chat Find counts rendered occurrences, highlights equivalent Unicode spellings, reveals long replies, and agrees with thread search.");
} finally {
  await close();
}
