import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", installed: true, format: "gguf", supportsReasoning: true };
const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_STREAM_PAUSES_BUILT === "1", firstRun: true,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
const status = page.locator(".text-composer-hint").getByRole("status");
const stream = page.getByRole("article", { name: "Response in progress" });
const update = (patch) => { state.textStatus.job = { ...state.textStatus.job, ...patch }; };

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await composer.fill("Show how to make a small example.");
  await button("Send message").click();
  await expect(status).toHaveText("Loading model…");
  update({ phase: "Waiting for the first token…" });
  await expect(stream).toContainText("Waiting for the first token…");
  await page.clock.fastForward(12_100);
  await expect(status).toHaveText("Still waiting for the first token…");
  await expect(stream).toContainText("Still waiting for the first token…");

  update({ partialReasoning: "Use a short example." });
  const summary = stream.locator("summary");
  await expect(summary).toHaveText("Reasoning…");
  await summary.click();
  await page.clock.fastForward(8_100);
  await expect(summary).toHaveText("Still reasoning…");
  await expect(stream.getByText("Use a short example.", { exact: true })).toBeVisible();
  await button("New chat").click();
  await expect(status).toHaveText("A response is running in another chat");
  await button("Open running chat").click();
  await expect(summary).toHaveText("Still reasoning…");
  update({ partialReasoning: "Use a short example. Keep the input small." });
  await expect(summary).toHaveText("Reasoning…");

  const fence = "```";
  const example = `A short example:\n\n${fence}python\nprint(1)\n`;
  update({ partialText: example });
  const code = stream.locator("pre code");
  const cursor = stream.locator(".text-stream-cursor");
  await expect(code).toContainText("print(1)");
  await expect(cursor).toBeVisible();
  await expect(status).toHaveText("Responding…");
  await expect(summary).toHaveText("Reasoning");
  await code.evaluate((element) => { element.dataset.originalExample = "true"; });
  const before = await code.boundingBox();
  await page.clock.fastForward(8_100);
  await expect(status).toHaveText("Waiting for more text…");
  await expect(cursor).toHaveAttribute("data-waiting", "true");
  await expect(cursor).toBeVisible();
  await expect(code).toHaveAttribute("data-original-example", "true");
  assert.deepEqual(await code.boundingBox(), before);

  update({ partialText: `${example}print(2)\n` });
  await expect(code).toContainText("print(2)");
  await expect(status).toHaveText("Responding…");
  await expect(cursor).not.toHaveAttribute("data-waiting");

  update({ status: "complete", partialText: `${example}print(2)\n${fence}` });
  await expect(stream).toHaveCount(0);
  await expect(page.locator("[data-original-example]")).toContainText("print(2)");
  await expect(page.getByRole("status", { name: "Reply status" })).toHaveText("Reply ready.");
  assert.deepEqual(errors, []);
  console.log("Long first-token, reasoning, and reply pauses are visible, and Markdown stays anchored through resumption and completion.");
} finally {
  await close();
}
