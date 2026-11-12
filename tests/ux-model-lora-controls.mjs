import assert from 'node:assert/strict';
import { fixture } from './ui-fixture.mjs';

const { page, state, errors, close } = await fixture();
const models = [
  { id: '9b', label: 'Klein 9B', bytes: 9e9, downloaded: 1e9, installed: false, state: 'downloading' },
  { id: '4b', label: 'Klein 4B', bytes: 4e9, downloaded: 0, installed: false, state: 'not-installed', uncensoredTextEncoder: { repoId: 'example/encoder', installed: false, enabled: false, state: 'not-installed', downloaded: 0, bytes: 2.1e9 } },
  { id: '4b-lora', label: 'Klein 4B · LoRA', bytes: 4e9, downloaded: 4e9, installed: true, state: 'installed' },
];
try {
  await page.route('**/api/models', route => route.fulfill({ json: { models } }));
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  const encoder = page.locator('.model-library-encoder-option');
  assert.equal(await encoder.evaluate(element => element.open), false);
  await encoder.locator('summary').click();
  await encoder.getByText('Install this model first.').waitFor();
  await page.locator('.model-library-custom > summary').click();
  assert.equal(await page.getByRole('button', { name: 'Cancel download', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Download', exact: true }).isDisabled(), true);
  const repoField = await page.getByRole('textbox', { name: 'Hugging Face repository' }).boundingBox();
  assert(repoField && Math.round(repoField.height) === 32, 'model import fields use the shared control height');
  for (const width of [1440, 1100, 800]) {
    await page.setViewportSize({ width, height: 900 });
    const card = page.locator('.model-library-card').filter({ has: page.getByRole('heading', { name: 'Klein 9B' }) });
    const heading = await card.getByRole('heading').boundingBox();
    const action = await card.getByRole('button', { name: 'Pause' }).boundingBox();
    assert(heading && action && heading.x + heading.width <= action.x, 'model title and action must not overlap');
    assert.equal(Math.round(action.height), 32, 'model actions use the shared control height');
    const geometry = await card.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const heading = element.querySelector('h4').getBoundingClientRect();
      return { left: heading.left - rect.left, right: rect.right - heading.right };
    });
    assert(geometry.left >= 16 && geometry.right >= 16, 'model content must remain inside the card padding');
  }
  models[1].installed = true;
  models[1].state = 'installed';
  models[1].uncensoredTextEncoder.installed = true;
  models[1].uncensoredTextEncoder.state = 'installed';
  const encoderToggle = page.getByRole('checkbox', { name: 'Use uncensored text encoder for Klein 4B' });
  await encoderToggle.waitFor({ timeout: 15000 });
  const encoderBox = await encoderToggle.boundingBox();
  assert(encoderBox && encoderBox.width === 16 && encoderBox.height === 16, 'encoder checkbox stays at the shared 16px size');
  models[0].state = 'not-installed';
  const loraCard = page.locator('.model-library-card').filter({ has: page.getByRole('heading', { name: 'Klein 4B · LoRA' }) });
  const remove = loraCard.getByRole('button', { name: 'Remove', exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Remove' && !button.disabled), { timeout: 15000 });
  await remove.click();
  const confirmation = loraCard.getByRole('group', { name: 'Confirm removal' });
  await confirmation.getByText('Remove model files? Your images and threads stay.').waitFor();
  assert.equal(await confirmation.getByRole('button', { name: 'Cancel' }).evaluate(element => element === document.activeElement), true, 'safe action receives focus');
  const cancelBox = await confirmation.getByRole('button', { name: 'Cancel' }).boundingBox();
  const removeBox = await confirmation.getByRole('button', { name: 'Remove model' }).boundingBox();
  assert(cancelBox && removeBox && cancelBox.x + cancelBox.width <= removeBox.x, 'confirmation actions remain separated');
  await page.keyboard.press('Escape');
  assert.equal(await confirmation.count(), 0, 'Escape cancels removal');
  await page.waitForFunction(element => element === document.activeElement, await remove.elementHandle());
  await remove.click();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForFunction(element => element === document.activeElement, await remove.elementHandle());
  await page.setViewportSize({ width: 800, height: 400 });
  const repository = page.getByRole('textbox', { name: 'Hugging Face repository' });
  await repository.fill('example/model-draft');
  const modelsBody = page.locator('.models-body');
  await modelsBody.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert(await modelsBody.evaluate(element => element.scrollTop) > 0, 'fixture can scroll the model list');
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  assert.equal(await modelsBody.evaluate(element => element.scrollTop), 0, 'switching category starts at its heading');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  assert.equal(await repository.inputValue(), 'example/model-draft', 'switching category preserves an unfinished model import');
  await repository.clear();
  models[0].state = 'failed';
  models[0].error = `Download failed: ${'long-error-detail-'.repeat(12)}`;
  const modelError = page.locator('.model-library-card').filter({ has: page.getByRole('heading', { name: 'Klein 9B' }) }).getByRole('alert');
  await modelError.waitFor({ timeout: 15000 });
  assert.equal(await modelError.evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
    probe.remove();
    return matches;
  }), true, 'model errors use the error color');
  assert(await modelError.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'long errors wrap within their card');
  await page.setViewportSize({ width: 1440, height: 900 });
  state.installedModels = [{ id: '4b-lora', label: 'Klein 4B · LoRA' }];
  await page.evaluate(() => { window.studio.pickLoraFiles = async () => ['C:\\styles\\claymation\\pytorch_lora_weights.safetensors', 'C:\\styles\\character.safetensors']; });
  await page.getByRole('button', { name: 'Stable title', exact: true }).click();
  await page.waitForResponse(response => response.url().includes('/api/flux2/status'));
  await page.locator('.composer-model-trigger').click();
  await page.getByRole('menuitemradio', { name: /Klein 4B · LoRA/ }).click();
  await page.locator('.workspace-header').getByRole('button', { name: 'Image settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add LoRA files' }).click();
  await page.getByText('claymation', { exact: true }).waitFor();
  const adapter = page.getByRole('checkbox', { name: 'pytorch_lora_weights.safetensors' });
  assert.equal(await adapter.isChecked(), true);
  const box = await adapter.boundingBox();
  assert(box && box.width === 16 && box.height === 16, 'checkbox stays at the shared 16px size');
  const rows = page.locator('.lora-control');
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  assert(first && second && second.y - (first.y + first.height) >= 8, 'adapter rows have breathing room');
  await adapter.uncheck();
  await page.getByText('1 of 2 active', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove pytorch_lora_weights.safetensors' }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'pytorch_lora_weights.safetensors' }).count(), 0);
  let downloadState = { status: 'idle' };
  await page.route('**/api/loras/download', route => {
    if (route.request().method() === 'POST') downloadState = { status: 'complete', path: 'C:\\data\\loras\\012345abcdef-pytorch_lora_weights.safetensors', name: 'pytorch_lora_weights.safetensors' };
    return route.fulfill({ json: downloadState });
  });
  await page.getByText('Download from a link', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Hugging Face or Civitai link' }).fill('https://huggingface.co/rehan-fal/klein-style-fleet/blob/main/claymation/pytorch_lora_weights.safetensors');
  await page.getByRole('button', { name: 'Download LoRA' }).click();
  await page.getByRole('button', { name: 'Add to thread' }).click();
  await page.getByText('claymation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Stable title', exact: true }).click();
  if (!await page.getByText('claymation', { exact: true }).isVisible()) await page.locator('.workspace-header').getByRole('button', { name: 'Image settings', exact: true }).click();
  await page.getByText('claymation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const header = page.locator('.library-view-header');
  const folder = await header.getByRole('button', { name: 'Open folder' }).boundingBox();
  const create = await header.getByRole('button', { name: 'New thread' }).boundingBox();
  assert(folder && create && folder.height === 32 && create.height === 32, 'page actions use the shared button height');
  assert(Math.abs((folder.y + folder.height / 2) - (create.y + create.height / 2)) < 1, 'page actions are vertically aligned');
  assert.deepEqual(errors, []);
  console.log('Model disclosures, download state, responsive layout and LoRA controls passed.');
} finally {
  await close();
}
