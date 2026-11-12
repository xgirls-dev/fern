import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, state, errors, close } = await fixture();
try {
  state.ttsStatus.models[0].installed = false;
  let setupCalls = 0;
  await page.route('**/api/tts/setup', route => { setupCalls += 1; return route.fulfill({ status: 500, json: { error: 'Unexpected setup' } }); });
  await page.reload();
  await page.locator('.sidebar-new-menu > button').click();
  await page.getByRole('menuitem', { name: 'New audio thread', exact: true }).click();
  await page.getByRole('button', { name: 'Find model setup' }).click();
  const setup = page.getByRole('button', { name: 'Set up model', exact: true });
  assert.equal(await setup.evaluate(element => element === document.activeElement), true, 'setup guidance focuses the setup action');
  assert.equal(setupCalls, 0, 'finding setup does not start a download');
  const box = await setup.boundingBox();
  const panel = await page.locator('.tts-composer-scroll').boundingBox();
  assert(box && panel && box.y >= panel.y && box.y + box.height <= panel.y + panel.height, 'setup action is visible after navigation');
  state.ttsStatus.models[0].installed = true;
  await page.reload();
  await page.getByRole('button', { name: 'Audio thread: New audio thread', exact: true }).first().click();
  await page.getByRole('button', { name: 'Write a script', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'tts-script');
  assert.deepEqual(errors, []);
  console.log('Audio empty state guides users to setup without starting a download.');
} finally {
  await close();
}
