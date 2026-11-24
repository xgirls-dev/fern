import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

let connection;
const model = { id: "local", name: "Local model", installed: true, format: "gguf" };
const { page, state, close, errors } = await fixture({
  builtRenderer: process.env.FERN_STREAM_UNICODE_BUILT === "1", firstRun: true,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, supportsJobEvents: true, job: { id: null, status: "idle" } },
  textJobEvents: (request, response) => {
    const query = new URL(request.url, "http://fixture").searchParams;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    connection = { id: query.get("jobId"), response };
  },
});
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const send = page.getByRole("button", { name: "Send message", exact: true });
const stream = page.getByRole("article", { name: "Response in progress" });
const reply = stream.locator(".text-message-content");
const respond = (partialText, status = "running", phase = "Waiting for the first token…") => {
  const job = { ...state.textStatus.job, partialText, status, phase };
  state.textStatus.job = job;
  assert.equal(connection.id, job.id);
  connection.response.write(`data: ${JSON.stringify({ job })}\n\n`);
  if (status === "complete") connection.response.end();
};

async function observeReply(prompt) {
  await composer.fill(prompt);
  await send.click();
  await expect(stream).toContainText("Loading model…");
  await expect.poll(() => connection?.id).toBe(state.textStatus.job.id);
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
  assert.equal(frames.length, 2, "A prose burst should appear as a prefix and then finish on the next frame");
  assertCompleteCharacters(frames, answer);

  const extended = `${answer} नमस्ते दुनिया!`;
  respond(extended);
  await expect(reply.locator("p")).toHaveText(extended);
  const extendedFrames = await page.evaluate(() => window.replyFrames);
  assertCompleteCharacters(extendedFrames, extended);
  const smallUpdate = `${extended} 👋`;
  respond(smallUpdate);
  await expect(reply.locator("p")).toHaveText(smallUpdate);
  assert.deepEqual((await page.evaluate(() => window.replyFrames)).slice(extendedFrames.length), [smallUpdate]);

  const duringTool = `${smallUpdate} This text is already visible while the model is busy.`;
  respond(duringTool, "running", "Checking the generated image…");
  await expect(reply.locator("p")).toHaveText(duringTool);
  const beforeResuming = await page.evaluate(() => window.replyFrames.length);
  const resumed = `${duringTool} 👩🏽‍💻 Carry on with the reply.`;
  respond(resumed);
  await expect(reply.locator("p")).toHaveText(resumed);
  const resumedFrames = (await page.evaluate(() => window.replyFrames)).slice(beforeResuming);
  assert(resumedFrames.every((frame) => frame.startsWith(duringTool)), "Resuming animation must preserve the already visible text.");
  assertCompleteCharacters(resumedFrames, resumed);

  const rich = `${resumed} Keep &copy; and **the accent** intact.`;
  respond(rich);
  await expect(reply.locator("strong")).toHaveText("the accent");
  await expect(reply.locator("p")).toHaveText(`${resumed} Keep © and the accent intact.`);
  respond(rich, "complete");
  await expect(stream).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await observeReply("Repeat the greeting with reduced motion.");
  respond(answer);
  await expect(reply.locator("p")).toHaveText(answer);
  assert.deepEqual(await page.evaluate(() => window.replyFrames), [answer]);
  respond(answer, "complete");
  await expect(stream).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Prose bursts catch up on the next frame, short updates render together, and Unicode and reduced motion stay intact.");
} finally {
  connection?.response.end();
  await close();
}
