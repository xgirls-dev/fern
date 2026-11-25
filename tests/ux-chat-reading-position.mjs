import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const leftId = "text-thread-left-reading";
const rightId = "text-thread-right-stream";
const messages = Array.from({ length: 420 }, (_, index) => ({
  id: `row-${index}`, role: index % 2 ? "assistant" : "user", createdAt: index + 1,
  content: index % 2 ? `Reply marker ${index}.\n\n${"Words that wrap differently when the window makes the conversation wider. ".repeat(18)}`
    : `Prompt marker ${index}.`,
}));
const models = [{ id: "local", name: "Local model", installed: true, format: "gguf" }];
const { page, state, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 1500, height: 900 },
  textStatus: { models, ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: leftId, threads: [
    { id: leftId, title: "Reading in the left pane", modelId: "local", messages },
    { id: rightId, title: "Streaming in the right pane", modelId: "local", messages: [] },
  ] },
});

const left = page.getByRole("region", { name: "Left chat", exact: true });
const right = page.getByRole("region", { name: "Right chat", exact: true });
const feed = left.getByRole("log", { name: "Conversation" });
const anchor = left.locator('[data-chat-message="row-96"]');
const anchorOffset = () => anchor.evaluate((element) => element.getBoundingClientRect().top -
  element.closest(".text-conversation").getBoundingClientRect().top);
const render = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.getByRole("button", { name: "Open split chat", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose a chat" }).getByRole("button", { name: /Streaming in the right pane/ }).click();
  await left.getByRole("button", { name: "Find in chat", exact: true }).click();
  const find = left.getByRole("searchbox", { name: "Search this chat" });
  await find.fill("Prompt marker 96.");
  await expect(anchor).toBeInViewport();
  await find.press("Escape");
  const expected = await anchorOffset();
  const beforeWidth = await feed.evaluate((element) => element.clientWidth);

  await right.getByRole("textbox", { name: "Message" }).fill("Start the other reply.");
  await right.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(right.getByRole("article", { name: "Response in progress" })).toBeVisible();
  await page.setViewportSize({ width: 850, height: 720 });
  await expect(left).toBeHidden();
  await render();
  state.textStatus.job = { ...state.textStatus.job, partialText: "A streamed update in the other pane.\n\n".repeat(34) };
  await expect(right.getByRole("article", { name: "Response in progress" })).toContainText("A streamed update in the other pane.");
  const firstFrame = await page.evaluateHandle(() => ({
    offset: new Promise((resolve) => {
      const pane = document.querySelector('[data-chat-pane="primary"]');
      const observer = new MutationObserver(() => {
        if (pane.getAttribute("data-focused") !== "true") return;
        observer.disconnect();
        requestAnimationFrame(() => {
          const row = pane.querySelector('[data-chat-message="row-96"]');
          const viewport = pane.querySelector(".text-conversation");
          resolve(row && row.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
        });
      });
      observer.observe(pane, { attributes: true, attributeFilter: ["data-focused"] });
    }),
  }));
  await page.getByRole("group", { name: "Chat panes" }).getByRole("button", { name: "Left chat", exact: true }).click();
  const firstOffset = await firstFrame.evaluate(({ offset }) => offset);
  await firstFrame.dispose();
  expect(firstOffset).not.toBeNull();
  expect(Math.abs(firstOffset - expected)).toBeLessThan(10);
  await expect(left).toBeVisible();
  await expect.poll(() => feed.evaluate((element) => element.clientWidth)).toBeGreaterThan(beforeWidth);
  await expect(anchor).toBeInViewport();
  await expect.poll(async () => Math.abs(await anchorOffset() - expected)).toBeLessThan(10);
  await expect(feed).not.toHaveAttribute("data-following", "true");
  expect(errors).toEqual([]);
  console.log(`Returning to the resized chat pane restored the message at ${await anchorOffset()}px (previously ${expected}px).`);
} finally {
  await close();
}
