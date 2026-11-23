import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, errors, close } = await fixture({ imageCount: 12, threadCount: 100 });
try {
  await page.setViewportSize({ width: 900, height: 320 });
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  const trigger = page.locator('.thumb-wrap').first().getByRole('button', { name: /^Image actions for / });
  await trigger.click();
  const popup = page.getByRole('menu', { name: 'Image actions', exact: true });
  await popup.waitFor({ state: 'visible' });
  const scrollable = await popup.evaluate(element => element.scrollHeight > element.clientHeight);
  assert(scrollable, 'short window makes the action menu scrollable');
  await popup.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(element => element.scrollTop > 0, await popup.elementHandle());
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'scrolling inside the menu keeps it open');
  const gallery = page.locator('.gallery-panel-body');
  await gallery.evaluate(element => { element.scrollTop = 300; });
  await popup.waitFor({ state: 'detached' });
  assert.equal(await gallery.evaluate(element => element.scrollTop), 300, 'closing the menu keeps the gallery at its new scroll position');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.sidebar-thread-row').first().hover();
  const threadAction = page.locator('.sidebar-thread-actions-trigger').first();
  await threadAction.click();
  const threadMenu = page.locator('.sidebar-thread-actions-menu');
  await threadMenu.waitFor();
  const threadList = page.locator('.sidebar-scroll-area');
  await threadList.evaluate(element => { element.scrollTop = 250; });
  await threadMenu.waitFor({ state: 'detached' });
  assert.equal(await threadList.evaluate(element => element.scrollTop), 250, 'closing the menu keeps the sidebar at its new scroll position');
  assert.deepEqual(errors, []);
  console.log('Image and thread menus close when their lists scroll; menu scrolling stays available.');
} finally {
  await close();
}
