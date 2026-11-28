import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, silentWav } from "./ui-fixture.mjs";

const { page, errors, dir, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
const script = page.getByRole("textbox", { name: "Text to speak" });
const generate = button("Generate speech");
const receiptKey = "fern-qwen3-tts-pending:v1";
const threadsKey = "fern-qwen3-tts-threads:v1";
const savedAt = Date.now() - 60_000;
const posted = [];
let savedId;
let releaseReceipt;

try {
  await page.route("**/api/tts/generate", async (route) => {
    const { requestId, threadId } = route.request().postDataJSON();
    posted.push({ requestId, threadId });
    if (posted.length === 1) {
      savedId = requestId;
      // The worker published a take, but the original renderer never gets a receipt.
      await new Promise((resolve) => { releaseReceipt = resolve; });
    }
    await route.abort().catch(() => {});
  });
  await page.route("**/api/tts/result?jobId=*", (route) => {
    const jobId = new URL(route.request().url()).searchParams.get("jobId");
    const name = `qwen3-tts-${jobId}.wav`;
    const output = jobId === savedId ? { name, url: `/outputs/${name}`, duration: 1, sampleRate: 24000, createdAt: savedAt } : null;
    return route.fulfill({ json: { output } });
  });
  const wav = silentWav(24_000, 1);
  await page.route("**/outputs/qwen3-tts-*.wav*", (route) => route.fulfill({ contentType: "audio/wav", body: wav }));

  await button("New thread").click();
  await page.getByRole("menuitem", { name: "Create speech", exact: true }).click();
  const original = "Recover this take even though the service lost its receipt.";
  await script.fill(original);
  await generate.click();
  await expect.poll(() => posted.length).toBe(1);
  const receipt = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), receiptKey);
  assert.equal(receipt.id, posted[0].requestId);
  assert.equal(receipt.threadId, posted[0].threadId);
  assert.equal(receipt.text, original);
  // Verify that the original thread was committed before the POST, even before unload.
  const initialThreads = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), threadsKey);
  assert.equal(initialThreads.threads.find((thread) => thread.id === receipt.threadId).text, original);

  await page.reload();
  releaseReceipt();
  await expect(page.getByText("Recovered your audio take", { exact: true })).toBeVisible();
  await button("View take").press("Enter");
  await expect(button("Play Take 1")).toBeFocused();
  await expect(script).toHaveValue(original);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBeNull();
  const savedThreads = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), threadsKey);
  assert.equal(savedThreads.threads.find((thread) => thread.id === receipt.threadId).outputs[0].createdAt, savedAt);
  await page.screenshot({ path: `${dir}/speech-take-recovered.png` });

  // A second restart with a stale receipt must leave one saved take and no repeated notice.
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [receiptKey, receipt]);
  await page.reload();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBeNull();
  await expect(page.locator(".audio-take")).toHaveCount(1);
  await expect(page.getByText("Recovered your audio take", { exact: true })).toHaveCount(0);

  const nextDraft = "Keep this draft if its WAV never finishes.";
  await script.fill(nextDraft);
  await generate.click();
  await expect(page.getByRole("region", { name: "Speech generation settings" }).getByRole("alert"))
    .toContainText("The audio job was interrupted before the take was saved.");
  await expect(generate).toBeEnabled();
  await expect(script).toHaveValue(nextDraft);
  await expect(page.locator(".audio-take")).toHaveCount(1);
  assert.equal(posted.length, 2);
  assert.notEqual(posted[0].requestId, posted[1].requestId);
  assert.deepEqual(errors, []);
  console.log("Speech recovered a take after losing the response, saved it exactly once, and kept the draft for an interrupted take.");
} finally {
  releaseReceipt?.();
  await close();
}
