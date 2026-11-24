import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
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
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(deleteSelected).toBeFocused();
  assert.equal(state.images.length, 4, 'cancelling leaves all images in place');
  await deleteSelected.click();
  const confirm = dialog.getByRole('button', { name: 'Delete images', exact: true });
  const select = page.getByRole('button', { name: 'Select', exact: true });
  await expect(confirm).toBeVisible();
  const resumeFrames = await page.evaluateHandle(() => {
    const { requestAnimationFrame } = window;
    let id = 0;
    window.requestAnimationFrame = () => --id;
    return () => { window.requestAnimationFrame = requestAnimationFrame; };
  });
  try {
    await confirm.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(select).toBeFocused();
    assert.deepEqual(state.images.map(image => image.name).sort(), ['audit-3.png', 'audit-4.png']);
  } finally {
    await resumeFrames.evaluate(restore => restore());
    await resumeFrames.dispose();
  }

  await select.press('Enter');
  await page.getByRole('button', { name: 'Select all results', exact: true }).press('Enter');
  await deleteSelected.press('Enter');
  await confirm.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create an image', exact: true })).toBeFocused();
  assert.equal(state.images.length, 0, 'confirming the remaining images empties the library');
  assert.deepEqual(errors, []);
  console.log('Library selection preserves cancellation and restores keyboard focus after partial or complete deletion.');
} finally { await close(); }
