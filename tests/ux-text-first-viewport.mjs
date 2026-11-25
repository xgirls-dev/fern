import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const cases = [
  { title: "Full last page", count: 120, height: 820, firstFrameRows: 12 },
  { title: "Full last page in a tall window", count: 120, height: 1720 },
  { title: "One-message last page in a tall window", count: 121, height: 1720 },
  { title: "Full last page before resize", count: 120, height: 710, firstFrameRows: 12, growTo: 1720 },
];
const intro = { id: "text-thread-viewport-intro", title: "Introduction", messages: [], modelId: "local" };
const threads = cases.map(({ title, count }, threadIndex) => ({
  id: `text-thread-viewport-${threadIndex}`,
  title,
  modelId: "local",
  messages: Array.from({ length: count }, (_, index) => ({
    id: `note-${threadIndex}-${index}`,
    createdAt: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    content: threadIndex === 0 && index % 2 === 1
      ? `## Note ${index + 1}\n\n${"Update the description and save the workshop notes. ".repeat(14)}`
      : `Short note ${index + 1}`,
  })),
}));
const { page, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 1440, height: 820 },
  legacyTextWorkspace: { activeId: intro.id, threads: [intro, ...threads] },
  textStatus: { models: [{ id: "local", name: "Local model", format: "gguf", installed: true }],
    ggufAvailable: true, job: { id: null, status: "idle" } },
});
const threadButton = (title) => page.getByRole("button", { name: `Text thread: ${title}`, exact: true });

async function checkFirstFrame(title, targetId, { expectedRows, resizeTo } = {}) {
  const button = threadButton(title);
  const capture = await button.evaluateHandle((element, { title, targetId, resizing }) => {
    let result;
    const trigger = resizing ? window : element;
    trigger.addEventListener(resizing ? "resize" : "click", () => {
      function measure() {
        if (document.querySelector(".text-header h2")?.textContent !== title) {
          requestAnimationFrame(measure);
          return;
        }
        const feed = document.querySelector(".text-conversation");
        const viewport = feed.getBoundingClientRect();
        const overlap = (node) => {
          if (!node) return 0;
          const bounds = node.getBoundingClientRect();
          return Math.max(0, Math.min(viewport.bottom, bounds.bottom) - Math.max(viewport.top, bounds.top));
        };
        result = {
          target: overlap(feed.querySelector(`[data-chat-message="${targetId}"]`)),
          deferred: [...feed.querySelectorAll("[data-chat-page][data-deferred]")].some((node) => overlap(node) > 0),
          mounted: feed.querySelectorAll("[data-chat-message]").length,
        };
      }
      requestAnimationFrame(measure);
    }, { capture: true, once: true });
    return () => result;
  }, { title, targetId, resizing: !!resizeTo });

  try {
    if (resizeTo) await page.setViewportSize({ width: 1440, height: resizeTo });
    else await button.click();
    let result;
    await expect.poll(async () => (result = await capture.evaluate((read) => read()))).toBeDefined();
    const context = resizeTo ? `${title} after resizing` : title;
    assert(result.target > 0, `${context} should show ${targetId} on its first frame`);
    assert.equal(result.deferred, false, `${context} should fill its first viewport with messages`);
    if (expectedRows !== undefined) assert.equal(result.mounted, expectedRows, `${title} should mount just one page`);
  } finally {
    await capture.dispose();
  }
}

try {
  for (const [index, { title, count, height, firstFrameRows, growTo }] of cases.entries()) {
    await page.setViewportSize({ width: 1440, height });
    const last = `note-${index}-${count - 1}`;
    await checkFirstFrame(title, last, { expectedRows: firstFrameRows });
    if (growTo) await checkFirstFrame(title, last, { resizeTo: growTo });
    await threadButton(intro.title).click();
  }

  const tallThread = cases[1].title;
  await threadButton(tallThread).click();
  await page.getByRole("log", { name: "Conversation" }).press("Home");
  await expect(page.locator('[data-chat-message="note-1-0"]')).toBeInViewport();
  await threadButton(intro.title).click();
  await checkFirstFrame(tallThread, "note-1-0");
  assert.deepEqual(errors, []);
  console.log("The right messages fill the first frame after opening, resizing, and returning to a saved position.");
} finally {
  await close();
}
