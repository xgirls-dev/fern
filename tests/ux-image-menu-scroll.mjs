import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, errors, close } = await fixture({ imageCount: 12, threadCount: 100 });
try {
  await page.setViewportSize({ width: 900, height: 320 });
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const details = page.locator('.thumb-wrap').first().locator('.image-menu');
  await details.locator('summary').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await details.locator('summary').click();
  const popup = details.locator('.image-menu-content');
  await popup.waitFor({ state: 'visible' });
  const scrollable = await popup.evaluate(element => element.scrollHeight > element.clientHeight);
  assert(scrollable, 'short window makes the action menu scrollable');
  await popup.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(element => element.scrollTop > 0, await popup.elementHandle());
  assert.equal(await details.evaluate(element => element.open), true, 'scrolling inside the menu keeps it open');
  await page.locator('.gallery-panel-body').evaluate(element => { element.scrollTop = 300; });
  await page.waitForFunction(element => !element.open, await details.elementHandle());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.sidebar-thread-row').first().hover();
  const threadAction = page.locator('.sidebar-thread-actions-trigger').first();
  await threadAction.click();
  const threadMenu = page.locator('.sidebar-thread-actions-menu');
  await threadMenu.waitFor();
  await page.locator('.sidebar-scroll-area').evaluate(element => { element.scrollTop = 250; });
  await threadMenu.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Image and thread menus close when their lists scroll; menu scrolling stays available.');
} finally {
  await close();
}
