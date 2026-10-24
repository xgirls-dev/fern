import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';
const textStatus = {
  models: [{ id: 'model-a', name: 'Qwen INT4', path: 'C:/models/qwen', installed: true }, { id: 'model-b', name: 'Second model', path: 'C:/models/second', installed: true }],
  runtimeAvailable: true, runtimeError: null, devices: ['AUTO', 'GPU', 'CPU'],
  job: { id: 'old-job', threadId: 'text-thread-old', status: 'complete', partialText: 'Stale response must never appear', result: null, error: null },
};
const { page, state, errors, dir, close } = await fixture({ textStatus });
const messages = () => page.locator('.text-message');
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('fern-text-threads:v1')));
async function until(test, label) {
  for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function complete(text) {
  state.textStatus.job = { ...state.textStatus.job, status: 'complete', partialText: text, finishedAt: Date.now()/1000,
    result: { inputTokens: 21, outputTokens: 9, generationSeconds: 0.6, tokensPerSecond: 15, modelName: 'Qwen INT4', device: 'GPU', seed: 42 } };
  await until(async () => (await page.locator('.text-message--assistant').last().textContent()).includes(text), 'completion');
}
try {
  await page.locator('.sidebar-new-menu > button').click();
  await page.getByRole('menuitem', { name: 'New text thread', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Remember the word fern.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => state.textRequests.length === 1, 'first request');
  assert.equal(state.textRequests[0].device, 'AUTO');
  state.textStatus.job.partialText = 'Streaming partial';
  await page.getByText('Streaming partial', { exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Draft while reading');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  assert.equal(state.textRequests.length, 1, 'Draft must not submit during generation');
  await complete('The word is fern.');
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Draft while reading');
  assert.equal(await messages().count(), 2);
  assert.equal(await page.getByText('Stale response must never appear').count(), 0);
  await page.getByLabel('Message', { exact: true }).fill('What was the word?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => state.textRequests.length === 2, 'second request');
  assert.equal(state.textRequests[1].messages.length, 3);
  state.textStatus.job.partialText = 'Remembered partial answer';
  await page.getByText('Remembered partial answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  await page.getByText('Stopped · Partial response', { exact: true }).waitFor();
  assert.equal(await messages().count(), 4);
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await until(() => state.textRequests.length === 3, 'retry request');
  assert.equal(state.textRequests[2].messages.length, 3, 'retry duplicated user message');
  await complete('Fern, as requested.');
  const activeId = (await saved()).activeId;
  await page.reload();
  await page.getByRole('button', { name: 'Text thread: Remember the word fern.', exact: true }).click();
  await until(async () => await messages().count() === 4, 'persisted messages');
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(await messages().count(), 4, 'completion duplicated after reload');
  await page.getByRole('button', { name: 'Text model', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Second model', exact: true }).click();
  await page.getByRole('button', { name: 'Response details', exact: true }).first().click();
  assert.equal(await page.locator('.text-message--assistant .text-message-label').first().textContent(), 'Qwen INT4');
  state.rejectText = 'Another image job is running.';
  await page.getByLabel('Message', { exact: true }).fill('A request that will be rejected.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText(state.rejectText, { exact: true }).waitFor();
  state.rejectText = null;
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await until(() => state.textRequests.length === 5, 'rejected-request retry');
  assert.equal(state.textRequests.at(-1).messages.length, 5);
  state.textStatus.job = { ...state.textStatus.job, status: 'failed', partialText: 'A useful partial response', error: 'GPU out of memory', finishedAt: Date.now()/1000 };
  await page.getByText('GPU out of memory', { exact: true }).waitFor();
  await page.getByText('A useful partial response', { exact: true }).waitFor();
  await page.screenshot({ path: `${dir}/text-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/text-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile horizontal overflow');
  const sendBox = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert(sendBox && sendBox.x >= 0 && sendBox.x + sendBox.width <= 390, 'send button outside viewport');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Simulate a saved in-flight job followed by a backend restart.
  await page.addInitScript(({ activeId }) => {
    const w = JSON.parse(localStorage.getItem('fern-text-threads:v1'));
    const t = w.threads.find(t => t.id === activeId);
    t.messages = t.messages.slice(0, -1); t.pendingJobId = 'lost-on-restart';
    localStorage.setItem('fern-text-threads:v1', JSON.stringify(w));
  }, { activeId });
  state.textStatus.job = { id: null, status: 'idle' };
  await page.reload();
  await page.getByRole('button', { name: 'Text thread: Remember the word fern.', exact: true }).click();
  await page.getByText('The backend restarted before this response was saved. Retry the response.', { exact: true }).waitFor();
  assert.equal(await messages().count(), 6);
  assert.deepEqual(errors, []);
  console.log('Text streaming, retries, partial failures, reload idempotency, model attribution, restart recovery and responsive layout passed.');
} finally { await close(); }
