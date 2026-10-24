// Opt-in: verifies recommended-model installation and a real GPU chat in the local UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './ui-fixture.mjs';

const root = resolve('.');
const installedModel = resolve(process.argv[2] || 'models/text/qwen3-4b-instruct-2507-openvino');
const isolated = await mkdtemp(resolve('tmp/text-recommended-live-'));
const python = resolve('.venv-release/Scripts/python.exe');
const child = spawn(python, ['-u', 'tests/text-api-fixture.py'], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    FERN_ROOT: isolated,
    FERN_TEXT_MODEL_ROOT: resolve(installedModel, '..'),
    FERN_TEXT_MODEL_REGISTRY: resolve(isolated, 'data/text-models.json'),
    PYTHONUTF8: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let logs = '';
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
const port = await new Promise((resolvePort, reject) => {
  const timer = setTimeout(() => reject(new Error(`API startup timeout: ${logs}`)), 30000);
  child.stdout.on('data', chunk => {
    const match = String(chunk).match(/FIXTURE_PORT=(\d+)/);
    if (match) { clearTimeout(timer); resolvePort(match[1]); }
  });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited ${code}: ${logs}`)); });
});
const api = `http://127.0.0.1:${port}`;
let browser;
async function apiJson(path, data) {
  const response = await fetch(api + path, data ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  } : {});
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}

try {
  const before = await apiJson('/api/text/status');
  assert.equal(before.defaultModelId, 'qwen3-4b-instruct-2507');
  assert.equal(before.recommendedModels[0].installed, false);
  browser = await fixture();
  const { page, errors } = browser;
  await page.route('**/api/text/**', async route => {
    const path = new URL(route.request().url()).pathname;
    try { await route.fulfill({ response: await route.fetch({ url: api + path, timeout: 30000 }) }); }
    catch (error) { console.error(`API proxy failure: ${path}`, error); await route.abort().catch(() => {}); }
  });

  await page.locator('.sidebar-new-menu > button').click();
  await page.getByRole('menuitem', { name: 'New text thread', exact: true }).click();
  await page.getByRole('button', { name: 'Browse models', exact: true }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: 'Installed', exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.sidebar-text-threads .sidebar-thread-button').first().click();
  await page.getByRole('button', { name: 'Text model', exact: true }).waitFor();
  const installed = await apiJson('/api/text/status');
  assert.equal(installed.recommendedModels[0].installed, true);
  assert.equal(installed.models.length, 1);
  assert.match(installed.models[0].name, /Qwen3(?:-| )4B(?:-| )Instruct(?:-| )2507/i);

  await page.getByLabel('Message', { exact: true }).fill('What is two plus two? Answer briefly.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Regenerate response', exact: true }).waitFor({ timeout: 180000 });
  assert.match(await page.locator('.text-message--assistant .text-message-content').last().textContent(), /four|4/i);
  await page.getByRole('button', { name: 'Response details', exact: true }).last().click();
  assert.match(await page.locator('.text-response-details').last().textContent(), /GPU/);
  assert.equal((await apiJson('/api/text/status')).job.modelId, installed.models[0].id);
  assert.deepEqual(errors, []);

  const registry = JSON.parse(await readFile(resolve(isolated, 'data/text-models.json'), 'utf8'));
  assert.equal(registry.models.length, 1);
  await apiJson('/api/text/models/remove', { modelId: registry.models[0].id });
  assert.equal((await apiJson('/api/text/status')).models.length, 0);
  assert((await readFile(resolve(installedModel, 'openvino_model.xml'))).length > 0);
  console.log('Recommended UI install, registry, default model, real GPU response, metrics, and safe unregister passed.');
} finally {
  if (logs.includes('Traceback')) console.error(logs);
  if (browser) await browser.close();
  child.stdin.end('\n');
  await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit); });
}
