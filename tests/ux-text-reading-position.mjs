import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

function longPassage(label) {
  return Array.from({ length: 70 }, (_, index) =>
    `**${label} ${index + 1}** Review the workshop notes and share the proposed changes with the team. Record any questions that come up before making a decision.${" Keep the notes updated.".repeat(index % 7)}`,
  ).join("  \n");
}

const { page, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_READING_POSITION_BUILT === "1", viewport: { width: 1160, height: 725 },
  textStatus: { models: [{ id: "local", name: "Local model", format: "gguf", installed: true }], ggufAvailable: true,
    job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: "text-thread-reading", threads: [
    { id: "text-thread-reading", title: "Workshop notes", modelId: "local", messages: [
      { id: "prompt", role: "user", content: "Summarize the workshop.", createdAt: 1 },
      { id: "reply", role: "assistant", content: longPassage("Workshop marker"), reasoning: longPassage("Reasoning marker"),
        status: "complete", createdAt: 2 },
    ] },
    { id: "text-thread-away", title: "Other notes", modelId: "local", messages: [], draft: "A separate draft." },
  ] },
});

const feed = page.getByRole("log", { name: "Conversation" });
const button = (name) => page.getByRole("button", { name, exact: true });
async function switchChat(title) {
  const toggle = page.locator("button[aria-controls='studio-sidebar']");
  const overlay = page.viewportSize().width <= 900;
  if (overlay) {
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await button(`Text thread: ${title}`).click();
  await expect(page.locator(".text-header h2")).toHaveText(title);
  if (overlay) await expect(toggle).toHaveAttribute("aria-expanded", "false");
}
const marker = (label) => feed.getByText(label, { exact: true });
const readOffset = (label) => marker(label).evaluate((node) => {
  const viewport = node.closest(".text-conversation").getBoundingClientRect();
  return node.getBoundingClientRect().top - viewport.top;
});
const passageHeight = async (label) => await readOffset(label) - await readOffset("Workshop marker 1");
const nearTop = async (label) => {
  await expect.poll(async () => Math.abs(await readOffset(label) - 6)).toBeLessThan(9);
};
async function readAt(label) {
  await feed.focus();
  await feed.press("Home");
  await marker(label).evaluate((node) => {
    const viewport = node.closest(".text-conversation");
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 6;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await nearTop(label);
  await expect(feed).not.toHaveAttribute("data-following", "true");
}

try {
  const answer = "Workshop marker 38";
  const inspector = page.getByRole("complementary", { name: "Chat settings panel" });
  await readAt(answer);
  const widePassage = await passageHeight(answer);
  const wide = await feed.locator(".text-transcript").evaluate((element) => element.clientWidth);
  await button("Chat settings").click();
  await expect(inspector).toBeVisible();
  await expect.poll(() => feed.locator(".text-transcript").evaluate((element) => element.clientWidth)).toBeLessThan(wide - 100);
  await nearTop(answer);
  await button("Close chat settings").click();
  await nearTop(answer);

  await switchChat("Other notes");
  await page.setViewportSize({ width: 930, height: 690 });
  await switchChat("Workshop notes");
  await expect.poll(() => passageHeight(answer)).toBeGreaterThan(widePassage + 100);
  await nearTop(answer);
  await page.setViewportSize({ width: 730, height: 690 });
  await nearTop(answer);
  await button("Chat settings").click();
  await expect(feed).toBeHidden();
  await switchChat("Other notes");
  await switchChat("Workshop notes");
  await expect(feed).toBeHidden();
  await button("Close chat settings").click();
  await nearTop(answer);

  await feed.locator(".text-reasoning summary").click();
  const reasoning = "Reasoning marker 32";
  await readAt(reasoning);
  await switchChat("Other notes");
  await page.setViewportSize({ width: 1080, height: 725 });
  await switchChat("Workshop notes");
  await expect(feed.locator(".text-reasoning")).toHaveAttribute("open", "");
  await nearTop(reasoning);

  await page.reload();
  await expect(feed.locator(".text-reasoning")).toHaveAttribute("open", "");
  await nearTop(reasoning);
  await expect(feed).not.toHaveAttribute("data-following", "true");

  await readAt(answer);
  await page.reload();
  await expect(feed).not.toHaveAttribute("data-following", "true");
  await nearTop(answer);

  await feed.focus();
  await feed.press("End");
  await expect(feed).toHaveAttribute("data-following", "true");
  await page.reload();
  await expect(marker("Workshop marker 70")).toBeAttached();
  await expect(feed).toHaveAttribute("data-following", "true");
  await button("Chat settings").click();
  await expect.poll(() => feed.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  assert.deepEqual(errors, []);
  console.log("Chat settings, width changes, thread switching, and reopening preserve the same answer or reasoning line, or follow the latest reply.");
} finally {
  await close();
}
