import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, state, errors, close } = await fixture({ imageCount: 4 });
try {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Select audit-1.png', exact: true }).click();
  await page.getByRole('button', { name: 'Select audit-2.png', exact: true }).click();
  await page.getByText('2 selected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete selected' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete selected images' });
  await dialog.getByText('Move 2 images to Recycle Bin?').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(state.images.length, 4, 'cancelling leaves all images in place');
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await dialog.getByRole('button', { name: 'Delete images' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(state.images.map(image => image.name).sort(), ['audit-3.png', 'audit-4.png']);
  assert.deepEqual(errors, []);
  console.log('Library selection deletes only confirmed images and preserves the rest.');
} finally { await close(); }
