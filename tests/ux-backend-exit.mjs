import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const idle = { id: null, status: "idle" };
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", format: "gguf", installed: true }],
    ggufAvailable: true, supportsJobPolling: true, job: idle,
  },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const partial = "Keep this partial answer.";
const draft = "Keep the follow-up draft too.";
let resolveStalePoll;
let holdNextPoll = false;

try {
  await page.route("**/api/text/job", async (route) => {
    let job = state.textStatus.job;
    if (holdNextPoll) {
      holdNextPoll = false;
      job = { ...job, status: "complete", partialText: "A stale reply from the old service." };
      await new Promise((resolve) => { resolveStalePoll = resolve; });
    }
    await route.fulfill({ json: job });
  });
  let restartCount = 0;
  await page.route("**/fixture/backend-retry", async (route) => {
    restartCount++;
    state.textStatus.job = idle;
    await route.fulfill({ json: { ok: true } });
  });
  await composer.fill("Show me a partial reply.");
  await button("Send message").click();
  await expect(page.getByRole("article", { name: "Response in progress" })).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, partialText: partial };
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  holdNextPoll = true;
  await expect.poll(() => typeof resolveStalePoll).toBe("function");
  await composer.fill(draft);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fern-fixture-backend-error", {
    detail: { message: "Fern’s local service stopped unexpectedly.", stage: "running" },
  })));
  await expect(page.getByRole("alert").filter({ hasText: "Fern’s local service stopped unexpectedly." })).toBeVisible();
  await expect(button("Stop generation")).toHaveCount(0);
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  const restart = button("Restart local service");
  await restart.focus();
  await restart.press("Enter");
  await expect(page.getByText("The backend restarted. The partial response was recovered.", { exact: true })).toBeVisible();
  const latePoll = page.waitForResponse("**/api/text/job");
  resolveStalePoll();
  await (await latePoll).finished();
  await expect(page.getByText("A stale reply from the old service.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  await expect(button("Send message")).toBeEnabled();
  assert.equal(restartCount, 1);
  assert.equal(state.textRequests.length, 1, "Restart should preserve the interrupted response for review.");
  await button("Send message").click();
  assert.equal(state.textRequests[1].messages.at(-1).content, draft);
  assert.deepEqual(errors, []);
  console.log("The service can restart while the interrupted answer and follow-up draft remain in Chat.");
} finally {
  resolveStalePoll?.();
  await close();
}
