import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
});
const codeBlock = 'Example with an [opening reference].\n\n```js\nconst example = 1;\n```\n\n';
const firstUpdate = codeBlock + "The output follows.\n\nMore details are coming.";
const longReply = firstUpdate + "\n\n" + Array.from({ length: 18 }, (_, index) =>
  `### Part ${index + 1}\n\n${"An earlier paragraph in the same response. ".repeat(30)}\n\n`,
).join("");
const reply = page.getByRole("log", { name: "Conversation" }).locator(".text-message--assistant").last();
const code = reply.locator("pre code");

try {
  await page.evaluate(() => {
    window.parsedMarkdownReplies = 0;
    window.finishedMarkdownRequests = 0;
    window.markdownWorkerSeeds = [];
    window.retainedSeedBlocks = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.blocks) window.parsedMarkdownReplies++;
          if (data.retained && data.retained.requestId === undefined) window.retainedSeedBlocks.push(data.retained.blockCount);
        });
      }
      postMessage(data) {
        if (typeof data.streaming !== "boolean") return super.postMessage(data);
        if (!data.streaming) window.finishedMarkdownRequests++;
        if (data.seedPrefix) window.markdownWorkerSeeds.push(data.seedPrefix.blockCount);
        if (window.holdMarkdownTail && data.content.endsWith(window.holdMarkdownTail)) {
          window.releaseMarkdownTail = () => super.postMessage(data);
          return;
        }
        super.postMessage(data);
      }
    };
  });
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Write a detailed answer.");
  const [worker] = await Promise.all([
    page.waitForEvent("worker"),
    page.getByRole("button", { name: "Send message", exact: true }).click(),
  ]);
  await expect(reply).toHaveClass(/text-message--streaming/);
  state.textStatus.job = { ...state.textStatus.job, partialText: firstUpdate };
  await expect(code).toHaveText("const example = 1;\n");
  await code.evaluate((element) => { element.dataset.beforeWorker = "true"; });

  state.textStatus.job = { ...state.textStatus.job, partialText: longReply + "First update." };
  await expect(reply).toContainText("First update.");
  await expect(code).toHaveAttribute("data-before-worker", "true");
  assert.deepEqual(await page.evaluate(() => window.markdownWorkerSeeds), [4]);
  assert.deepEqual(await page.evaluate(() => window.retainedSeedBlocks), [4]);

  state.textStatus.job = { ...state.textStatus.job, partialText: longReply + "First update. Next update." };
  await expect(reply).toContainText("Next update.");
  await expect(reply.getByRole("heading", { name: /^Part / })).toHaveCount(18);
  await expect(code).toHaveAttribute("data-before-worker", "true");
  state.textStatus.job = {
    ...state.textStatus.job,
    status: "complete",
    partialText: longReply + "First update. Next update.\n\nSee the [reference].\n\n[reference]: https://example.com/info\n\n[opening reference]: https://example.com/intro\n\nEntity &copy;. <span>Literal HTML</span>",
    finishedAt: Date.now() / 1000,
  };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(reply.getByRole("link", { name: "reference", exact: true })).toHaveAttribute("href", "https://example.com/info");
  await expect(reply.getByRole("link", { name: "opening reference", exact: true })).toHaveAttribute("href", "https://example.com/intro");
  await expect(reply).toContainText("<span>Literal HTML</span>");
  await expect(reply).toContainText("Entity ©.");
  assert(await page.evaluate(() => window.parsedMarkdownReplies >= 3));
  await expect(code).toHaveAttribute("data-before-worker", "true");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });

  await composer.fill("Write a title I can select while the reply streams.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  const title = "Keep this title selected";
  const formattedTitle = `${title}\n---`;
  state.textStatus.job = { ...state.textStatus.job, partialText: longReply + title };
  const titleParagraph = reply.locator("p").filter({ hasText: title });
  await titleParagraph.scrollIntoViewIfNeeded();
  await page.evaluate((tail) => { window.holdMarkdownTail = tail; }, formattedTitle);
  state.textStatus.job = { ...state.textStatus.job, partialText: longReply + formattedTitle };
  await expect.poll(() => page.evaluate(() => typeof window.releaseMarkdownTail)).toBe("function");
  const bounds = await titleParagraph.evaluate((element) => {
    const text = document.createRange();
    text.selectNodeContents(element);
    const { left, right, top, height } = text.getBoundingClientRect();
    return { start: Math.floor(left) + 1, end: Math.ceil(right) - 1, y: top + height / 2 };
  });
  await page.mouse.move(bounds.start, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.end, bounds.y, { steps: 8 });
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe(title);
  const priorParses = await page.evaluate(() => {
    const count = window.parsedMarkdownReplies;
    window.holdMarkdownTail = "";
    window.releaseMarkdownTail();
    return count;
  });
  await expect.poll(() => page.evaluate(() => window.parsedMarkdownReplies)).toBeGreaterThan(priorParses);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(titleParagraph).toHaveText(title);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe(title);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(reply.getByRole("heading", { name: title })).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);

  // A small ordinary tail can finalize directly from the already rendered prefix.
  const completedRequests = await page.evaluate(() => window.finishedMarkdownRequests);
  const mediumReply = codeBlock + Array.from({ length: 14 }, (_, index) =>
    `### Short section ${index + 1}\n\n${"A compact paragraph giving enough context for the answer. ".repeat(5)}\n\n`,
  ).join("");
  await composer.fill("Finish with a compact tail.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  state.textStatus.job = { ...state.textStatus.job, partialText: mediumReply + "**Preview ending" };
  await expect(reply.locator("strong")).toHaveText("Preview ending");
  state.textStatus.job = {
    ...state.textStatus.job,
    status: "complete",
    partialText: mediumReply + "**Preview ending with literal markers.",
    finishedAt: Date.now() / 1000,
  };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(reply).toContainText("**Preview ending with literal markers.");
  await expect(reply.getByRole("heading", { name: /^Short section / })).toHaveCount(14);
  assert.equal(await page.evaluate(() => window.finishedMarkdownRequests), completedRequests,
    "An eligible final tail should render without another worker request.");
  const snapshots = [
    longReply + "First item\n\n- One\n- Two",
    longReply + "First item\n\n- One\n- Two\n\n  continued\n\nAn evolving title",
    longReply + "First item\n\n- One\n- Two\n\n  continued\n\nAn evolving title\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |",
  ];
  const comparison = await page.evaluate(async ({ url, snapshots, longReply }) => {
    const parser = new Worker(url, { type: "module" });
    let id = 0;
    const acknowledged = new Map();
    function parse(content, view, streaming, previousId = acknowledged.get(view)?.id) {
      return new Promise((resolve, reject) => {
        parser.onmessage = ({ data }) => {
          const previous = acknowledged.get(view);
          if (!data.blocks || (data.retained && data.retained.requestId !== previous?.id)) {
            reject(new Error("Worker returned an invalid Markdown update"));
            return;
          }
          const blocks = previous?.blocks.slice(0, data.retained?.blockCount ?? 0) ?? [];
          if (data.tableRows) {
            const node = structuredClone(previous.blocks[blocks.length].node);
            const body = node.children.find((part) => part.tagName === "tbody");
            body.children.splice(data.tableRows.rowCount * 2 + 1, Infinity, ...data.tableRows.tail);
            blocks.push({ signature: JSON.stringify(node), node });
          }
          blocks.push(...data.blocks);
          acknowledged.set(view, { id: data.id, blocks });
          resolve({ blocks, transferred: data.blocks.length, matchesFinal: data.matchesFinal, tableRows: data.tableRows });
        };
        parser.onerror = reject;
        parser.postMessage({ id: ++id, view, content, streaming, previousId });
      });
    }
    try {
      let savedBlocks = 0;
      for (const [index, snapshot] of snapshots.entries()) {
        const incremental = await parse(snapshot, "live", true);
        const full = await parse(snapshot, `fresh-${index}`, true);
        if (JSON.stringify(incremental.blocks) !== JSON.stringify(full.blocks)) return { matches: false };
        savedBlocks += full.transferred - incremental.transferred;
      }
      const final = snapshots.at(-1) + "\n\nDone.";
      const unchanged = await parse(final, "live", true);
      const incremental = await parse(final, "live", false);
      const full = await parse(final, "fresh-final", false);
      const unfinishedTable = snapshots[0] + "\n\n| Option | Result |\n| ---";
      const unfinishedEmphasis = snapshots[0] + "\n\n**Still writing";
      const changed = [];
      for (const [index, content] of [unfinishedTable, unfinishedEmphasis].entries()) {
        const preview = await parse(content, `unfinished-${index}`, true);
        const settled = await parse(content, `settled-${index}`, false);
        changed.push(!preview.matchesFinal && JSON.stringify(preview.blocks) !== JSON.stringify(settled.blocks));
      }
      await parse(snapshots[0], "missing-ack", true);
      const recovered = await parse(snapshots[1], "missing-ack", true, -1);
      const fresh = await parse(snapshots[1], "fresh-recovery", true);
      const table = longReply + "| Choice | Result |\n| --- | ---: |\n" + Array.from({ length: 32 }, (_, index) =>
        `| Option ${index} with **detail** and \\| pipe | &copy; [guide](https://example.com/guide) |\n`).join("");
      const tableSnapshots = [table, `${table}| Last | **writing`, `${table}| Last | **done** |\n`,
        `${table}| Last | **done** |\n\nA new paragraph.`, `${table}| Last | [resource] |\n\n[resource]: https://example.com/resource`];
      const tableUpdates = [];
      for (const [index, snapshot] of tableSnapshots.entries()) {
        const streaming = index < tableSnapshots.length - 2;
        const update = await parse(snapshot, "growing-table", streaming);
        const full = await parse(snapshot, `fresh-table-${index}`, streaming);
        tableUpdates.push({ matches: JSON.stringify(update.blocks) === JSON.stringify(full.blocks),
          rows: update.tableRows?.rowCount ?? 0, tail: update.tableRows?.tail.length ?? 0 });
      }
      return {
        matches: JSON.stringify(incremental.blocks) === JSON.stringify(full.blocks),
        unchangedMatchesFinal: unchanged.matchesFinal && JSON.stringify(unchanged.blocks) === JSON.stringify(full.blocks),
        changedPreviewsReparse: changed.every(Boolean),
        savedBlocks,
        tableUpdates,
        recovered: recovered.transferred === fresh.transferred &&
          JSON.stringify(recovered.blocks) === JSON.stringify(fresh.blocks),
      };
    } finally {
      parser.terminate();
    }
  }, { url: worker.url(), snapshots, longReply });
  assert(comparison.matches, "Incremental rendering should agree with a fresh parse.");
  assert(comparison.unchangedMatchesFinal, "A preview that matches the final parse can be reused.");
  assert(comparison.changedPreviewsReparse, "Repaired emphasis and hidden table syntax still require a final parse.");
  assert(comparison.savedBlocks > 24, "Stable blocks should not be transferred repeatedly.");
  assert(comparison.recovered, "An unacknowledged prefix should produce a complete result.");
  assert(comparison.tableUpdates.every(({ matches }) => matches), JSON.stringify(comparison.tableUpdates));
  assert.deepEqual(comparison.tableUpdates.map(({ rows, tail }) => [rows, tail]), [[0, 0], [32, 2], [32, 2], [33, 0], [0, 0]]);

  await composer.fill("Start with plain paragraphs, then add a formatted section.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  const plain = Array.from({ length: 18 }, (_, index) => (
    `Plain paragraph ${index + 1} begins here.\n${"Keep reading while the next words arrive. ".repeat(6).trimEnd()}`
  )).join("\n\n");
  const workerRepliesBeforeProse = await page.evaluate(() => window.parsedMarkdownReplies);
  state.textStatus.job = { ...state.textStatus.job, partialText: plain };
  const paragraphs = reply.locator(".text-message-content > p");
  await expect(paragraphs).toHaveCount(18);
  await expect(paragraphs.last()).toHaveText(plain.split("\n\n").at(-1));
  await paragraphs.first().evaluate((element) => { element.dataset.prosePrefix = "true"; });
  assert.equal(await page.evaluate(() => window.parsedMarkdownReplies), workerRepliesBeforeProse,
    "A long plain reply should render without sending its paragraphs to the Markdown worker.");

  const formatted = plain + "\n\nFormatted section\n---\n\nVisit https://example.com/fern and keep &copy; intact.";
  state.textStatus.job = { ...state.textStatus.job, partialText: formatted };
  await expect(reply.getByRole("heading", { name: "Formatted section" })).toBeVisible();
  await expect(reply.getByRole("link", { name: "https://example.com/fern" })).toHaveAttribute("href", "https://example.com/fern");
  await expect(reply).toContainText("keep © intact.");
  await expect(paragraphs.first()).toHaveAttribute("data-prose-prefix", "true");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(paragraphs.first()).toHaveAttribute("data-prose-prefix", "true");

  await expect.poll(async () => (await savedTextWorkspace(page)).threads
    .flatMap((thread) => thread.messages).some((message) => message.content.endsWith("literal markers."))).toBe(true);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const historyRequests = [];
    let historyReleased = false;
    window.markdownHistoryBlocked = () => historyRequests.length > 0;
    window.releaseMarkdownHistory = () => {
      historyReleased = true;
      for (const send of historyRequests.splice(0)) send();
    };
    window.Worker = class extends NativeWorker {
      postMessage(data) {
        if (typeof data.streaming !== "boolean") return super.postMessage(data);
        this.markdownHistory ??= !data.streaming;
        if (window.pendingFormattingTail && data.content.endsWith(window.pendingFormattingTail)) {
          window.releasePendingFormatting = () => super.postMessage(data);
          return;
        }
        if (this.markdownHistory && !historyReleased) historyRequests.push(() => super.postMessage(data));
        else super.postMessage(data);
      }
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.markdownHistoryBlocked())).toBe(true);
  const holdFormatting = (tail) => page.evaluate((ending) => {
    window.pendingFormattingTail = ending;
    window.releasePendingFormatting = undefined;
  }, tail);
  const releaseFormatting = () => page.evaluate(() => {
    window.pendingFormattingTail = "";
    window.releasePendingFormatting();
  });
  const formatting = reply.locator("[data-chat-markdown-formatting]");
  const replyStatus = page.getByRole("status", { name: "Reply status" });
  await composer.fill("Write a new reply while saved replies are being opened.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await expect.poll(() => state.textStatus.job.status).toBe("running");
  await holdFormatting("**This is a live update");
  state.textStatus.job = { ...state.textStatus.job, partialText: `${mediumReply}**This is a live update` };
  await expect(formatting).toHaveText("Formatting response…");
  await expect(reply.locator(".text-message-content")).not.toContainText("### Short section");
  await expect.poll(() => page.evaluate(() => typeof window.releasePendingFormatting)).toBe("function");
  await releaseFormatting();
  await expect(reply.locator("strong")).toHaveText("This is a live update");
  state.textStatus.job = {
    ...state.textStatus.job,
    status: "complete",
    partialText: `${mediumReply}See the [new resource].\n\n[new resource]: https://example.com/new`,
    finishedAt: Date.now() / 1000,
  };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(reply.getByRole("link", { name: "new resource" })).toHaveAttribute("href", "https://example.com/new");

  await composer.fill("Return the finished answer in one update.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await expect.poll(() => state.textStatus.job.status).toBe("running");
  await holdFormatting("**The final answer arrived in one update.**");
  state.textStatus.job = { ...state.textStatus.job, status: "complete",
    partialText: `${mediumReply}**The final answer arrived in one update.**`, finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(formatting).toHaveText("Formatting response…");
  await expect(replyStatus).toBeEmpty();
  await expect(reply.locator(".text-message-content")).not.toContainText("### Short section");
  await expect.poll(() => page.evaluate(() => typeof window.releasePendingFormatting)).toBe("function");
  await releaseFormatting();
  await expect(reply.locator("strong")).toHaveText("The final answer arrived in one update.");
  await expect(formatting).toHaveCount(0);
  await expect(replyStatus).toHaveText("Reply ready.");

  await page.getByRole("button", { name: "Regenerate response", exact: true }).click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await expect(reply.locator("strong")).toHaveText("The final answer arrived in one update.");
  await expect.poll(() => state.textStatus.job.status).toBe("running");
  state.textStatus.job = { ...state.textStatus.job, status: "complete",
    partialText: `${mediumReply}**The regenerated answer arrived in one update.**`, finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(reply.locator("strong")).toHaveText("The regenerated answer arrived in one update.");
  assert(await page.evaluate(() => window.markdownHistoryBlocked()), "The live reply should finish before saved replies are released.");
  await page.evaluate(() => window.releaseMarkdownHistory());
  await expect(page.getByRole("link", { name: "reference", exact: true })).toHaveAttribute("href", "https://example.com/info");

  await composer.fill("Stop this reply while it is reasoning.");
  await send.click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  const beginning = "First we should review the notes.";
  const ending = "**The retained reasoning is now formatted.**";
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialReasoning: beginning };
  const reasoning = reply.locator(".text-reasoning");
  await reasoning.locator("summary").click();
  await expect(reasoning.getByText(beginning)).toBeVisible();
  await holdFormatting(ending);
  state.textStatus.job = { ...state.textStatus.job, status: "stopped", partialReasoning: `${beginning}\n\n${mediumReply}${ending}`,
    finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(reasoning.locator("[data-chat-markdown-formatting]")).toHaveText("Formatting response…");
  await expect(replyStatus).toBeEmpty();
  await expect.poll(() => page.evaluate(() => typeof window.releasePendingFormatting)).toBe("function");
  await releaseFormatting();
  await expect(reasoning.locator("strong")).toHaveText("The retained reasoning is now formatted.");
  await expect(replyStatus).toHaveText("Response stopped. Partial reply available.");

  assert.deepEqual(errors, []);
  console.log("Long replies keep code mounted, resolve late references, and finish while historical Markdown is queued.");
} finally {
  await close();
}
