import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, errors, close } = await fixture({
  builtRenderer: process.env.FERN_SCROLL_BUILT === "1",
  firstRun: true,
  viewport: { width: 1060, height: 640 },
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
    ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
});

const feed = page.getByRole("log", { name: "Conversation" });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const jump = page.getByRole("button", { name: "Jump to latest message", exact: true });
const goToReply = page.getByRole("button", { name: "Go to latest reply", exact: true });
const reply = feed.locator(".text-message--assistant");
const position = () => feed.evaluate((element) => ({
  top: element.scrollTop,
  gap: element.scrollHeight - element.clientHeight - element.scrollTop,
}));
const atLatest = () => expect.poll(async () => (await position()).gap).toBeLessThanOrEqual(2);
const followUpDraft = "I am typing a follow-up as the reply arrives.\n".repeat(12);
let content = "";
let polls = 0;

async function append(label, count = 12) {
  content += Array.from({ length: count }, (_, index) => `${label} ${index + 1}.\n\n`).join("");
  state.textStatus.job = { ...state.textStatus.job, partialText: content };
  await expect(reply.getByText(`${label} ${count}.`, { exact: true })).toBeAttached();
}

try {
  await page.route("**/api/text/job", (route) => {
    polls += 1;
    return route.fulfill({ json: state.textStatus.job });
  });
  await composer.fill("Give me a long response I can read as it arrives.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(reply).toHaveClass(/text-message--streaming/);
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…" };
  await append("Introduction", 32);
  await atLatest();
  await composer.focus();
  await composer.press("Shift+Tab");
  await expect(goToReply).toBeFocused();
  await expect(goToReply).toHaveCSS("clip-path", "none");
  await goToReply.press("Enter");
  await expect(reply).toBeFocused();
  await expect(reply).toHaveCSS("outline-style", "solid");
  await expect(reply.getByText("Introduction 1.", { exact: true })).toBeInViewport();
  await expect(feed).not.toHaveAttribute("data-following", "true");
  const liveReading = await position();
  await append("Below the reading position", 3);
  await expect(reply).toBeFocused();
  await expect.poll(async () => (await position()).top).toBeCloseTo(liveReading.top, 0);
  await reply.press("End");
  await expect(reply).toBeFocused();
  await expect(feed).toHaveAttribute("data-following", "true");
  await expect(jump).toHaveCount(0);
  await atLatest();
  const bounds = await feed.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -26);
  await expect.poll(async () => (await position()).gap).toBeGreaterThan(20);
  await expect(jump).toBeVisible();
  const reading = await position();
  assert(reading.gap < 48, `Expected a small scroll away from the tail, got ${reading.gap}px`);

  await composer.fill(followUpDraft);
  await expect.poll(async () => (await position()).gap).toBeGreaterThan(reading.gap + 100);
  await expect.poll(async () => (await position()).top).toBeCloseTo(reading.top, 0);
  await composer.fill("");

  await append("Continued text");
  await expect.poll(async () => (await position()).top).toBeCloseTo(reading.top, 0);
  await expect(jump).toBeVisible();

  await page.setViewportSize({ width: 1060, height: 1220 });
  await atLatest(); // The larger viewport clamps the scroll position to the end.
  await append("Text after resizing");
  await expect.poll(async () => (await position()).top).toBeLessThanOrEqual(reading.top + 1);
  await expect.poll(async () => (await position()).gap).toBeGreaterThan(300);
  await expect(jump).toBeVisible();

  // Model a line landing just as a downward scroll reaches the previous tail.
  await feed.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 16; });
  await atLatest();
  await page.mouse.wheel(0, -64);
  await expect(jump).toBeVisible();
  await page.mouse.wheel(0, 2400);
  await atLatest();
  await expect(jump).toHaveCount(0);
  await append("Following again");
  await atLatest();
  await composer.fill(followUpDraft);
  await atLatest();
  await composer.fill("");
  await atLatest();
  await expect(jump).toHaveCount(0);

  await feed.focus();
  await feed.press("PageUp");
  await expect(jump).toBeVisible();
  await feed.press("End");
  await atLatest();
  await expect(jump).toHaveCount(0);
  await append("After using End");
  await atLatest();

  await page.mouse.wheel(0, -28);
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(composer).toBeFocused();
  await append("After jumping to latest");
  await atLatest();

  const fence = "`".repeat(3);
  content += `${fence}js\nconsole.log("An example worth copying");\n${fence}\n\n`;
  state.textStatus.job = { ...state.textStatus.job, partialText: content };
  const copyCode = reply.getByRole("button", { name: "Copy code", exact: true });
  await expect(copyCode).toBeInViewport();
  await copyCode.focus();
  await expect(feed).not.toHaveAttribute("data-following", "true");
  const codePosition = (await position()).top;
  await append("New text below the focused code");
  await expect(copyCode).toBeFocused();
  await expect(copyCode).toBeInViewport();
  await expect.poll(async () => (await position()).top).toBeCloseTo(codePosition, 0);
  await jump.click();
  await atLatest();

  await feed.focus();
  await feed.press("Home");
  await feed.getByRole("button", { name: "Edit message", exact: true }).click();
  const edit = feed.getByRole("textbox", { name: "Edited prompt" });
  await edit.fill("An unsent revision of the prompt.");
  await expect(edit).toBeFocused();
  await page.mouse.wheel(0, 780);
  await expect.poll(async () => (await position()).top).toBeGreaterThan(700);
  const awayFromEdit = await position();
  await append("Reading while editing");
  await expect.poll(async () => (await position()).top).toBeCloseTo(awayFromEdit.top, 0);
  await expect(edit).toHaveValue("An unsent revision of the prompt.");
  await expect(edit).toBeFocused();
  await page.keyboard.press("Escape");
  await feed.focus();
  await feed.press("End");

  const selected = "Keep this exact phrase selected";
  content += selected;
  state.textStatus.job = { ...state.textStatus.job, partialText: content };
  const selectedParagraph = reply.getByText(selected, { exact: true });
  await expect(selectedParagraph).toBeAttached();
  await atLatest();
  await expect(selectedParagraph).toBeInViewport({ ratio: 1 });
  const drag = await selectedParagraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = range.getBoundingClientRect();
    return { start: Math.floor(bounds.left) + 1, end: Math.ceil(bounds.right) - 1, y: bounds.top + bounds.height / 2 };
  });
  await page.mouse.move(drag.start, drag.y);
  await page.mouse.down();
  const beforeDrag = polls;
  content += " even as";
  state.textStatus.job = { ...state.textStatus.job, partialText: content };
  await expect.poll(() => polls).toBeGreaterThan(beforeDrag + 1);
  await expect(selectedParagraph).toHaveText(selected);
  await page.mouse.move(drag.end, drag.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe(selected);
  await expect(feed).not.toHaveAttribute("data-following", "true");
  const beforeSelectionUpdate = polls;
  content += " the last paragraph grows.";
  state.textStatus.job = { ...state.textStatus.job, partialText: content };
  await expect.poll(() => polls).toBeGreaterThan(beforeSelectionUpdate + 1);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
  await expect(selectedParagraph).toBeInViewport();

  const lastLine = "The complete response is ready.";
  content += `\n\n${lastLine}`;
  state.textStatus.job = { ...state.textStatus.job, partialText: content, status: "complete", finishedAt: Date.now() / 1000 };
  await expect(reply).not.toHaveClass(/text-message--streaming/);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(reply.getByText(lastLine, { exact: true })).toBeAttached();
  await jump.click();
  await expect(reply.getByRole("button", { name: "Copy message", exact: true })).toBeInViewport();
  await atLatest();
  await composer.focus();
  await composer.press("Shift+Tab");
  await expect(goToReply).toBeFocused();
  await expect(goToReply).toHaveCSS("clip-path", "none");
  await goToReply.press("Enter");
  await expect(reply).toBeFocused();
  await expect(reply.getByText("Introduction 1.", { exact: true })).toBeInViewport();
  assert.deepEqual(errors, []);
  console.log("Keyboard navigation to live replies, resize, editing, and text selection preserve the reading position until follow is resumed.");
} finally {
  await close();
}
