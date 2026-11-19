import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, state, errors, close } = await fixture();
try {
  state.ttsStatus.models[0].installed = false;
  let setupCalls = 0;
  await page.route('**/api/tts/setup', route => { setupCalls += 1; return route.fulfill({ status: 500, json: { error: 'Unexpected setup' } }); });
  await page.reload();
  await page.locator('.sidebar-new-menu > button').click();
  await page.getByRole('menuitem', { name: 'Create speech', exact: true }).click();
  const setup = page.getByRole('button', { name: 'Set up model', exact: true });
  await setup.waitFor();
  await page.setViewportSize({ width: 1080, height: 720 });
  await page.waitForFunction(() => {
    const footer = document.querySelector('.tts-composer-footer');
    const button = [...(footer?.querySelectorAll('button') ?? [])]
      .find(element => element.textContent.trim() === 'Set up model');
    if (!button) return false;
    const panel = footer.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return window.innerWidth === 1080 && box.height > 0 &&
      box.top >= Math.max(0, panel.top) && box.bottom <= Math.min(window.innerHeight, panel.bottom);
  });
  assert.equal(setupCalls, 0, 'opening the speech composer does not start a download');
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
