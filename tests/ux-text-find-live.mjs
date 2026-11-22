import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", installed: true, format: "gguf", supportsReasoning: true };
const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_FIND_LIVE_BUILT === "1", firstRun: true, viewport: { width: 1050, height: 680 },
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { status: "idle", id: null } },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const feed = page.getByRole("log", { name: "Conversation" });
const stream = feed.getByRole("article", { name: "Response in progress" });
const search = page.getByRole("searchbox", { name: "Search this chat" });
const count = page.getByRole("search", { name: "Find in chat" }).getByRole("status");
const reason = "The earlier reasoning mentions a signal trace.";
const opening = "The first signal **trace** is an example.\n\n";
const filler = Array.from({ length: 40 }, (_, index) => `Example ${index + 1} adds an ordinary paragraph.`).join("\n\n");
const update = (patch) => { state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", ...patch }; };
const currentHit = () => page.evaluate(() => {
  const range = [...(CSS.highlights.get("fern-chat-find") ?? [])][0];
  return range ? { text: range.toString(), line: range.startContainer.parentElement.closest("p")?.textContent } : null;
});

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Explain how to read a sample.");
  await button("Send message").click();
  await expect(stream).toBeVisible();
  await button("Find in chat").click();
  await search.fill("signal trace");
  await expect(count).toHaveText("No matches");
  update({ partialReasoning: reason });
  await expect(count).toHaveText("1 of 1");
  await expect(stream.locator("details")).toHaveAttribute("open", "");
  await expect.poll(currentHit).toEqual({ text: "signal trace", line: reason });

  const text = `${opening}${filler}`;
  update({ partialText: text });
  await expect(count).toHaveText("2 of 2");
  await expect.poll(currentHit).toEqual({ text: "signal trace", line: reason });
  await search.press("Enter");
  const firstBody = { text: "signal trace", line: "The first signal trace is an example." };
  await expect(count).toHaveText("1 of 2");
  await expect.poll(currentHit).toEqual(firstBody);
  await expect(stream.locator("details")).not.toHaveAttribute("open");

  await feed.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(400);
  const lastParagraph = "One more signal trace appears below.";
  const final = `${text}\n\n${lastParagraph}`;
  update({ partialText: final });
  await expect(count).toHaveText("1 of 3");
  await expect.poll(currentHit).toEqual(firstBody);
  assert.equal(await feed.evaluate((element) => element.scrollTop), 400);
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(count).toHaveText("2 of 3");
  await expect.poll(currentHit).toEqual({ text: "signal trace", line: lastParagraph });
  update({ status: "complete", finishedAt: Date.now() / 1000 });
  await expect(stream).toHaveCount(0);
  await expect(count).toHaveText("2 of 3");
  await expect.poll(currentHit).toEqual({ text: "signal trace", line: lastParagraph });

  await search.press("Escape");
  await button("Regenerate response").click();
  await expect(stream).toBeVisible();
  await button("Find in chat").click();
  await search.fill("retry landmark");
  const retry = "The retry landmark is easy to spot.";
  update({ partialText: retry });
  await expect(count).toHaveText("1 of 1");
  await expect.poll(currentHit).toEqual({ text: "retry landmark", line: retry });
  const continued = `${retry} There is more in the same paragraph.`;
  update({ partialText: continued });
  await expect.poll(currentHit).toEqual({ text: "retry landmark", line: continued });
  update({ status: "complete", finishedAt: Date.now() / 1000 });
  await expect(stream).toHaveCount(0);
  await expect(count).toHaveText("1 of 1");
  await expect.poll(currentHit).toEqual({ text: "retry landmark", line: continued });
  await search.press("Escape");
  await expect.poll(currentHit).toBeNull();
  assert.deepEqual(errors, []);
  console.log("Chat Find follows live text and reasoning, preserves the selected occurrence and reading position, and survives reply completion and regeneration.");
} finally {
  await close();
}
