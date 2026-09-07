// Runs an isolated Electron shell check. No Fern window, model, or user image is opened.
const { app, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../artifacts/ux-verification');
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, `recycle-fixture-${Date.now()}.png`);
  assert(file.startsWith(root + path.sep));
  await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64'));
  await shell.trashItem(file);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
  const error = await shell.openPath(path.join(root, 'does-not-exist.png'));
  assert.equal(typeof error, 'string'); assert(error.length > 0);
  await fs.writeFile(path.join(root, 'native-results.json'), JSON.stringify({ recycleBin: 'passed', missingFileError: 'passed' }, null, 2));
  console.log('PASS: isolated fixture moved to Windows Recycle Bin; missing-file open returns an error.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
