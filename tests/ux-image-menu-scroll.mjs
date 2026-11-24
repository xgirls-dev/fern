import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
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
  const filter = page.getByRole('searchbox', { name: 'Filter images', exact: true });
  await filter.fill('Original image prompt');
  assert.equal(await page.locator('.thumb').count(), 12, 'the filter keeps all matching cards');
  assert.equal(await gallery.evaluate(element => element.scrollTop), 0, 'a new search starts at its first result');
  await filter.fill('');
  await page.setViewportSize({ width: 1140, height: 405 });
  await gallery.evaluate(element => new Promise(resolve => {
    element.addEventListener('scroll', resolve, { once: true });
    element.scrollTop = 120;
  }));
  await page.getByRole('button', { name: 'Stable title', exact: true }).click();
  await gallery.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await gallery.waitFor();
  assert.equal(await gallery.evaluate(element => element.scrollTop), 120, 'reopening Images restores the last position');
  await page.setViewportSize({ width: 1440, height: 900 });
  await gallery.evaluate(element => new Promise(resolve => {
    element.scrollTop = 0;
    // Let the resize and scroll events settle before opening the next menu.
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.evaluate(() => {
    window.studio.copyText = async (text) => { window.copiedImagePrompt = text; };
  });
  const other = page.getByRole('button', { name: 'Image actions for audit-11.png', exact: true });
  await other.press('ArrowDown');
  await expect(popup.getByRole('menuitem', { name: 'Save image', exact: true })).toBeFocused();
  await popup.getByRole('menuitem', { name: 'Copy prompt', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.copiedImagePrompt)).toBe('Original image prompt 11');
  await expect(other).toBeFocused();
  await trigger.press('ArrowDown');
  await popup.getByRole('menuitem', { name: 'Delete image', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('audit-12.png');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(popup).toHaveCount(0);
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
