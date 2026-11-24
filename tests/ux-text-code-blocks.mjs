import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, close, errors } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_CODE_BLOCKS_BUILT === "1", viewport: { width: 864, height: 695 },
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }], ggufAvailable: true,
    supportsJobPolling: true, job: { id: null, status: "idle" } },
});

const fence = "`".repeat(3);
const script = `# Keep note\nvalue = "${"workshop-".repeat(32)}"\nprint(value, 42)\n`;
const unknown = 'literal <input value="leave this alone">\n';
const powershell = 'Write-Output "Ready"\n';
const reply = page.getByRole("log", { name: "Conversation" }).locator(".text-message--assistant").last();
const block = reply.locator(".text-code-block").first();
const python = block.locator("pre");
const code = python.locator("code");
const wrap = block.getByRole("button", { name: "Wrap code", exact: true });
let releaseHighlight;
let imports = 0;

const tokens = (group, index = 0) => reply.locator("pre code").nth(index).evaluate((element, groupName) =>
  Array.from(CSS.highlights.get(`fern-code-${groupName}`) ?? [])
    .filter((range) => element.contains(range.startContainer))
    .map((range) => range.startContainer.textContent.slice(range.startOffset, range.endOffset)),
group);

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.route(/\/textCodeHighlight\.worker[^/]*\.(?:js|ts)(?:\?.*)?$/, async (route) => {
    imports += 1;
    await new Promise((resolve) => { releaseHighlight = resolve; });
    await route.continue();
  });
  await page.evaluate(() => {
    window.studio.copyText = async (value) => { window.codeClipboard = value; };
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Show me a Python snippet.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialText: `${fence}py\n${script}` };

  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(reply.getByRole("region", { name: "py code" })).toBeVisible();
  await expect(python).toHaveAttribute("tabindex", "0");
  await python.press("ArrowRight");
  await expect.poll(() => python.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  assert.equal(imports, 0, "An in-progress reply must not load the syntax worker.");

  await wrap.press("Space");
  await expect(wrap).toBeFocused();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(python).toHaveCSS("white-space", "pre-wrap");
  await expect.poll(() => python.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await code.evaluate((element) => { element.dataset.originalCode = "true"; });

  const full = `${fence}py\n${script}${fence}\n\n${fence}made-up\n${unknown}${fence}\n\n${fence}ps1\n${powershell}${fence}`;
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: full, finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  await expect.poll(() => typeof releaseHighlight).toBe("function");
  assert.equal(await code.textContent(), script);
  assert.deepEqual(await tokens("keyword"), []);
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await code.evaluate((element) => {
    const text = element.firstChild;
    const offset = text.data.indexOf("42");
    window.getSelection().setBaseAndExtent(text, offset, text, offset + 2);
  });
  releaseHighlight();
  await expect.poll(() => tokens("keyword")).toContain("print");
  assert.deepEqual(await tokens("comment"), ["# Keep note"]);
  assert.deepEqual(await tokens("value"), ["42"]);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), "42");
  await expect(code).toHaveAttribute("data-original-code", "true");
  assert.equal(await code.textContent(), script);
  assert.equal(await reply.locator("pre code").nth(1).textContent(), unknown);
  assert.deepEqual(await tokens("name", 1), []);
  await expect.poll(() => tokens("keyword", 2)).toContain("Write-Output");
  assert.equal(imports, 1, "Settled blocks should share a single syntax worker.");
  await expect(reply.locator("pre input")).toHaveCount(0);

  const keywordColor = () => code.evaluate((element) => getComputedStyle(element, "::highlight(fern-code-keyword)").color);
  assert.equal(await keywordColor(), "rgb(103, 43, 147)");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  assert.equal(await keywordColor(), "rgb(203, 166, 240)");
  await block.getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal(await page.evaluate(() => window.codeClipboard), script);

  await wrap.press("Space");
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(python).toHaveAttribute("tabindex", "0");
  await page.getByRole("button", { name: "Find in chat", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search this chat" });
  await search.fill("print");
  await expect.poll(() => page.evaluate(() => {
    const match = CSS.highlights.get("fern-chat-find");
    const syntax = CSS.highlights.get("fern-code-keyword");
    return match && syntax && match.priority > syntax.priority ? [...match][0]?.toString() : "";
  })).toBe("print");
  await search.press("Escape");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("fern-code-keyword"))).toBe(false);
  assert.deepEqual(errors, []);
  console.log("Code colors, selection, wrapping during streaming, keyboard scrolling, exact copying, and highlight cleanup passed.");
} finally {
  releaseHighlight?.();
  await close();
}
