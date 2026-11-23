import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_TABLES_BUILT === "1", viewport: { width: 864, height: 720 },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }], ggufAvailable: true,
    supportsJobPolling: true, job: { id: null, status: "idle" } },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const feed = page.getByRole("log", { name: "Conversation" });
const reply = feed.locator(".text-message--assistant").last();
const block = reply.locator(".text-table-block").first();
const table = block.getByRole("table");
const scroller = block.locator(".text-table-scroll");
const fit = block.getByRole("button", { name: "Fit table to chat", exact: true });
const headers = ["Plan", "Date", "Owner", "Budget", "Delta", "Status", "Notes", "Reference", "Steps", "Risk", "Decision"];
const row = (values) => `| ${values.join(" | ")} |`;
const first = [
  "Workshop", "2026-10-02", "**Mina**", "=SUM(A1:A3)", "-3.5", "@ready", "A longer note about the workshop that can wrap.",
  "[See draft](https://example.invalid/draft)", "One step", "Low", "Final signoff",
];
const markdown = [row(headers), row(headers.map((name) => name === "Delta" ? "---:" : "---")), row(first)].join("\n");
const updates = `${markdown}\n${row(["Follow-up", "2026-10-08"])}`;
const clipboard = [
  headers,
  ["Workshop", "2026-10-02", "Mina", "'=SUM(A1:A3)", "-3.5", "'@ready", first[6], "See draft", "One step", "Low", "Final signoff"],
  ["Follow-up", "2026-10-08", ...Array(9).fill("")],
].map((values) => values.join("\t")).join("\n");
const overflow = () => scroller.evaluate((element) => element.scrollWidth - element.clientWidth);

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.evaluate(() => { window.studio.copyText = async (value) => { window.tableClipboard = value; }; });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Compare the workshop options in a table.");
  await button("Send message").click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialText: markdown };
  await expect(block).toHaveCSS("margin-bottom", "0px");
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  await expect(reply.getByRole("region", { name: "Scrollable table" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Plan" })).toHaveCSS("border-inline-start-width", "0px");
  await expect(table.getByRole("columnheader", { name: "Date" })).toHaveCSS("border-inline-start-width", "1px");
  await expect(table.getByRole("cell", { name: "-3.5" })).toHaveCSS("text-align", "right");
  await expect.poll(overflow).toBeGreaterThan(80);
  await table.evaluate((element) => { element.dataset.originalTable = "true"; });
  await scroller.press("ArrowRight");
  await expect(scroller).toBeFocused();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(feed).not.toHaveAttribute("data-following", "true");

  await fit.press("Space");
  await expect(fit).toBeFocused();
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  const heading = await table.getByRole("columnheader", { name: "Reference" }).evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
    return { lines, whiteSpace: getComputedStyle(cell).whiteSpace };
  });
  assert.equal(heading.lines, 1, JSON.stringify(heading));
  state.textStatus.job = { ...state.textStatus.job, partialText: updates };
  await expect(table.getByRole("cell", { name: "Follow-up" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Follow-up" })).toHaveCSS("border-inline-start-width", "0px");
  await expect(table.getByRole("cell", { name: "2026-10-08" })).toHaveCSS("border-inline-start-width", "1px");
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await expect(table).toHaveAttribute("data-original-table", "true");
  const copyTable = button("Copy table");
  await copyTable.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Copy table as tab-separated values" })).toBeVisible();
  await copyTable.click();
  assert.equal(await page.evaluate(() => window.tableClipboard), clipboard);
  await expect(button("Table copied")).toBeVisible();

  const secondary = [row(headers.map((header) => header.repeat(10))), row(headers.map(() => "---")), row(headers)].join("\n");
  const dense = reply.locator(".text-table-block").nth(1);
  state.textStatus.job = { ...state.textStatus.job, partialText: `${updates}\n\n${secondary}` };
  await expect(dense).toHaveCSS("margin-bottom", "0px");
  await expect(block).toHaveCSS("margin-bottom", "16px");
  state.textStatus.job = { ...state.textStatus.job, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await expect(table).toHaveAttribute("data-original-table", "true");
  await dense.getByRole("button", { name: "Fit table to chat", exact: true }).click();
  await expect.poll(() => dense.locator(".text-table-scroll").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await fit.press("Space");
  await expect.poll(overflow).toBeGreaterThan(80);
  await scroller.evaluate((element) => { element.scrollLeft = 0; });
  await button("Find in chat").click();
  await page.getByRole("searchbox", { name: "Search this chat" }).fill("Final signoff");
  await expect.poll(() => scroller.evaluate((element) => {
    const mark = [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    return !!mark && mark.left >= view.left && mark.right <= view.right && element.scrollLeft > 0;
  })).toBe(true);
  assert.deepEqual(errors, []);
  console.log("Wide streamed tables preserve keyboard focus and fit state, copy tidy spreadsheet rows, and reveal off-screen matches.");
} finally {
  await close();
}
