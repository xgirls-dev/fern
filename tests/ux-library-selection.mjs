import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, state, errors, close } = await fixture({ imageCount: 4 });
try {
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: /^Select.*audit-1\.png$/, exact: true }).click();
  await page.getByRole('button', { name: /^Select.*audit-2\.png$/, exact: true }).click();
  await page.getByText('2 selected', { exact: true }).waitFor();
  const deleteSelected = page.getByRole('button', { name: 'Delete selected' });
  await deleteSelected.click();
  const dialog = page.getByRole('alertdialog', { name: 'Move 2 images to Recycle Bin?', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await page.waitForFunction(element => element === document.activeElement, await cancel.elementHandle());
  await cancel.click();
  await page.waitForFunction(element => element === document.activeElement, await deleteSelected.elementHandle());
  assert.equal(state.images.length, 4, 'cancelling leaves all images in place');
  await deleteSelected.click();
  await dialog.getByRole('button', { name: 'Delete images' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(element => element === document.activeElement, await page.getByRole('button', { name: 'Select', exact: true }).elementHandle());
  assert.deepEqual(state.images.map(image => image.name).sort(), ['audit-3.png', 'audit-4.png']);
  assert.deepEqual(errors, []);
  console.log('Library selection deletes only confirmed images and preserves the rest.');
} finally { await close(); }
