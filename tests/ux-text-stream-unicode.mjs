import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", installed: true, format: "gguf" };
const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_STREAM_UNICODE_BUILT === "1", firstRun: true,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const send = page.getByRole("button", { name: "Send message", exact: true });
const stream = page.getByRole("article", { name: "Response in progress" });
const reply = stream.locator(".text-message-content");
const respond = (partialText, status = "running") => {
  state.textStatus.job = { ...state.textStatus.job, partialText, status, phase: "Waiting for the first token…" };
};

async function observeReply(prompt) {
  await composer.fill(prompt);
  await send.click();
  await expect(stream).toContainText("Loading model…");
  await reply.evaluate((element) => {
    const frames = [];
    window.replyFrames = frames;
    const observer = new MutationObserver(() => {
      const current = element.querySelector("p")?.textContent;
      if (current && current !== frames.at(-1)) frames.push(current);
    });
    observer.observe(element, { subtree: true, characterData: true, childList: true });
  });
}

function assertCompleteCharacters(frames, text) {
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment, index }) => text.slice(0, index + segment.length)));
  assert(frames.every((frame) => boundaries.has(frame)), `Streaming split a visible character: ${JSON.stringify(frames)}`);
  assert.equal(frames.at(-1), text);
}

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  const answer = "Go👩🏽‍💻 e\u0301 🇲🇽!";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await observeReply("Send a greeting with an emoji and an accent.");
  respond(answer);
  await expect(reply.locator("p")).toHaveText(answer);
  const frames = await page.evaluate(() => window.replyFrames);
  assert(frames.length > 1, "Prose should arrive in multiple rendered frames when motion is enabled");
  assertCompleteCharacters(frames, answer);

  const extended = `${answer} नमस्ते दुनिया!`;
  respond(extended);
  await expect(reply.locator("p")).toHaveText(extended);
  assertCompleteCharacters(await page.evaluate(() => window.replyFrames), extended);
  respond(extended, "complete");
  await expect(stream).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await observeReply("Repeat the greeting with reduced motion.");
  respond(answer);
  await expect(reply.locator("p")).toHaveText(answer);
  assert.deepEqual(await page.evaluate(() => window.replyFrames), [answer]);
  respond(answer, "complete");
  await expect(stream).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Animated prose preserves Unicode character boundaries across updates, and reduced motion renders each update at once.");
} finally {
  await close();
}
