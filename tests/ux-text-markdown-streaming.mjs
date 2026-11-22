import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_MARKDOWN_BUILT === "1",
  firstRun: true,
  viewport: { width: 864, height: 640 },
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const conversation = page.getByRole("log", { name: "Conversation" });
const reply = conversation.locator(".text-message--assistant").last();
const body = reply.locator(".text-message-content");
const code = body.locator("pre code");
const table = body.getByRole("table");
let jobPolls = 0;
let externalImages = 0;
const fence = "`".repeat(3);
const prose = "Here is **the small example**.\n\n";
const program = 'print("Hello, world")';
const codeStart = `${prose}${fence}python\n${program}\n`;
const tableHeader = "| Option | Result |";

async function sendSnapshot(partialText) {
  const before = jobPolls;
  state.textStatus.job = { ...state.textStatus.job, partialText };
  await expect.poll(() => jobPolls).toBeGreaterThan(before + 1);
}

try {
  await page.route("**/api/text/job", (route) => {
    jobPolls += 1;
    return route.fulfill({ json: state.textStatus.job });
  });
  await page.route("https://markdown-preview.invalid/**", (route) => {
    externalImages += 1;
    return route.abort();
  });
  await page.evaluate(() => { window.capturedMarkdownClipboard = ""; window.studio.copyText = async (value) => {
    window.capturedMarkdownClipboard = value;
  }; });
  await composer.fill("Show me code and a table.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  await sendSnapshot("Here is **the small example");
  await expect(body.locator("strong")).toHaveText("the small example");

  await sendSnapshot(`${prose}${fence.slice(0, 2)}`);
  await expect(body).not.toContainText(fence.slice(0, 2));
  await sendSnapshot(`${prose}${fence}py`);
  await expect(code).toHaveCount(0);
  await sendSnapshot(codeStart);
  await expect(code).toContainText(program);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await code.evaluate((element) => {
    element.dataset.originalCode = "true";
    let previous = element.textContent;
    window.streamingCodeUpdates = [];
    const updates = new MutationObserver(() => {
      if (element.textContent === previous) return;
      previous = element.textContent;
      window.streamingCodeUpdates.push(previous);
    });
    updates.observe(element, { subtree: true, characterData: true, childList: true });
  });
  const addedLine = 'print("One formatted batch arrives together")';
  const extendedCode = `${codeStart}${addedLine}\n`;
  await sendSnapshot(extendedCode);
  await expect(code).toContainText(addedLine);
  assert.deepEqual(await page.evaluate(() => window.streamingCodeUpdates), [`${program}\n${addedLine}\n`]);
  await sendSnapshot(`${extendedCode}${fence.slice(0, 2)}`);
  await expect(code).not.toContainText(fence.slice(0, 2));
  await reply.getByRole("button", { name: "Copy code", exact: true }).click();
  const copiedText = await page.evaluate(() => window.capturedMarkdownClipboard);
  assert.equal(copiedText.trimEnd(), `${program}\n${addedLine}`);

  const literalLine = `${fence.slice(0, 2)}\n`;
  await sendSnapshot(`${extendedCode}${literalLine}`);
  await expect(code).toContainText(fence.slice(0, 2));
  const afterCode = `${extendedCode}${literalLine}${fence}\n\n`;
  await sendSnapshot(`${afterCode}|`);
  await expect(body).not.toContainText("|");
  await sendSnapshot(`${afterCode}${tableHeader}\n| ---`);
  await expect(body).not.toContainText("| ---");
  await sendSnapshot(`${afterCode}${tableHeader}\n| --- | --- |\n| Early | Work in progress`);
  await expect(table).toBeVisible();
  await expect(table.getByRole("cell", { name: "Work in progress" })).toBeVisible();
  await table.evaluate((element) => { element.dataset.originalTable = "true"; });
  const afterTable = `${afterCode}${tableHeader}\n| --- | --- |\n| Early | Work in progress |\n\n`;
  await sendSnapshot(`${afterTable}[Read the docs](https://markdown-preview.invalid/doc`);
  await expect(body).toContainText("Read the docs");
  await expect(body.getByRole("link", { name: "Read the docs" })).toHaveCount(0);

  const final = `${afterTable}[Read the docs](https://markdown-preview.invalid/doc)\n\n![Generated alt text](https://markdown-preview.invalid/image.png)\n\nA literal ending: **unfinished`;
  state.textStatus.job = { ...state.textStatus.job, partialText: final, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect(code).toHaveAttribute("data-original-code", "true");
  await expect(table).toHaveAttribute("data-original-table", "true");
  await expect(body.getByRole("link", { name: "Read the docs" })).toHaveAttribute("href", "https://markdown-preview.invalid/doc");
  await expect(body).toContainText("Generated alt text");
  await expect(body).toContainText("A literal ending: **unfinished");
  await reply.getByRole("button", { name: "Copy message", exact: true }).click();
  assert.equal(await page.evaluate(() => window.capturedMarkdownClipboard), final);
  assert.equal(externalImages, 0);
  assert.deepEqual(errors, []);
  console.log("Streaming Markdown preserves code and table elements, hides partial syntax, and settles to the original reply.");
} finally {
  await close();
}
