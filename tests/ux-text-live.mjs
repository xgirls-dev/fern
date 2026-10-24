// Opt-in: uses a real local INT4 export, invisible Chromium and isolated API data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './ui-fixture.mjs';
const root = resolve('.');
const isolated = await mkdtemp(resolve('tmp/text-live-'));
const model = resolve(process.argv[2] || 'models/qwen2.5-0.5b-instruct-int4');
const python = resolve('.venv-release/Scripts/python.exe');
const child = spawn(python, ['-u', 'tests/text-api-fixture.py'], { cwd: root, windowsHide: true, env: { ...process.env, FERN_ROOT: isolated, PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
const port = await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`API startup timeout: ${logs}`)), 30000);
  child.stdout.on('data', chunk => { const m = String(chunk).match(/FIXTURE_PORT=(\d+)/); if (m) { clearTimeout(timer); res(m[1]); } });
  child.once('exit', code => { clearTimeout(timer); rej(new Error(`API exited ${code}: ${logs}`)); });
});
const api = `http://127.0.0.1:${port}`;
console.log('Isolated API ready');
let browser;
async function apiJson(path, data) {
  const response = await fetch(api + path, data ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) } : {});
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}
try {
  browser = await fixture();
  const { page, errors, dir } = browser;
  await page.route('**/api/text/**', async route => {
    const path = new URL(route.request().url()).pathname;
    try {
      const response = await route.fetch({ url: api + path, timeout: 30000 });
      await route.fulfill({ response });
    } catch (error) {
      console.error('API proxy failure:', path, logs);
      await route.abort().catch(() => {});
    }
  });
  await page.evaluate(path => { window.studio.pickTextModelFolder = async () => path; }, model);
  await page.locator('.sidebar-new-menu > button').click();
  await page.getByRole('menuitem', {name:'New text thread', exact:true}).click();
  await page.getByRole('button', {name:'Generation settings', exact:true}).click();
  await page.getByRole('complementary', {name:'Chat settings panel'}).getByRole('button', {name:'Manage models', exact:true}).click();
  await page.getByRole('button', {name:'Add local model', exact:true}).click();
  console.log('Import requested');
  await page.locator('.sidebar-text-threads .sidebar-thread-button').first().click();
  await page.getByRole('button', {name:'Generation settings', exact:true}).click();
  await page.getByLabel('Temperature',{exact:true}).focus();
  await page.keyboard.press('Home');
  await page.getByRole('button',{name:'Close chat settings',exact:true}).click();
  await page.getByLabel('Message', {exact:true}).fill('Remember the code word fern. Reply with the code word only.');
  await page.getByRole('button', {name:'Send message', exact:true}).click();
  console.log('First response requested');
  await page.getByRole('button', {name:'Regenerate response', exact:true}).waitFor({timeout:180000});
  assert.match(await page.locator('.text-message--assistant .text-message-content').last().textContent(), /fern/i);
  await page.getByRole('button',{name:'Response details',exact:true}).last().click();
  assert.match(await page.locator('.text-response-details').last().textContent(), /GPU/);
  await page.getByLabel('Message', {exact:true}).fill('What code word did I give you?');
  await page.getByRole('button', {name:'Send message', exact:true}).click();
  await page.getByRole('button', {name:'Regenerate response', exact:true}).waitFor({timeout:60000});
  assert.match(await page.locator('.text-message--assistant .text-message-content').last().textContent(), /fern/i);
  const threadTitle = await page.locator('.text-header h2').textContent();
  await page.reload();
  await page.getByRole('button', {name:`Text thread: ${threadTitle}`, exact:true}).click();
  await page.locator('.text-message').nth(3).waitFor();
  assert.equal(await page.locator('.text-message').count(), 4);
  await page.getByLabel('Message', {exact:true}).fill('Write a very long essay about 100 species of trees.');
  await page.getByRole('button', {name:'Send message', exact:true}).click();
  await page.locator('.text-message--streaming').waitFor();
  await page.getByRole('button', {name:'Stop generation', exact:true}).click();
  await page.getByRole('button', {name:'Retry response', exact:true}).waitFor({timeout:30000});
  assert.equal((await apiJson('/api/text/status')).job.status, 'stopped');
  await page.getByRole('button', {name:'Generation settings', exact:true}).click();
  await page.getByRole('combobox', {name:'Compute device', exact:true}).selectOption('CPU');
  await page.getByLabel('Maximum output', {exact:true}).selectOption('128');
  await page.getByRole('button', {name:'Close chat settings', exact:true}).click();
  await page.getByRole('button', {name:'Retry response', exact:true}).click();
  await page.getByRole('button', {name:'Regenerate response', exact:true}).waitFor({timeout:180000});
  await page.getByRole('button',{name:'Response details',exact:true}).last().click();
  assert.match(await page.locator('.text-response-details').last().textContent(), /CPU/);
  await page.screenshot({path:`${dir}/text-real-model.png`, fullPage:true});
  const registryPath = resolve(isolated, 'data/text-models.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(registry.models.length, 1);
  // A missing registered folder must be explicit without touching the model.
  const entry = registry.models[0];
  const original = entry.path;
  const { writeFile } = await import('node:fs/promises');
  entry.path = resolve(isolated, 'nonexistent');
  await writeFile(registryPath, JSON.stringify(registry));
  assert.equal((await apiJson('/api/text/status')).models[0].installed, false);
  entry.path = original;
  await writeFile(registryPath, JSON.stringify(registry));
  await apiJson('/api/text/models/remove', {modelId:entry.id});
  assert.equal((await apiJson('/api/text/status')).models.length, 0);
  assert((await readFile(resolve(model, 'openvino_model.xml'))).length > 0);
  assert.deepEqual(errors, []);
  console.log('Real UI → API → INT4 model: import, GPU multi-turn, reload persistence, stop, CPU retry, missing folder and safe removal passed.');
} finally {
  if (logs.includes('Traceback')) console.error(logs);
  if (browser) await browser.close();
  child.stdin.end('\n');
  await new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', res); });
}
