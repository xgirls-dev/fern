// Builds real Electron menus with isolated editing callbacks; never changes the user's dictionary.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
app.whenReady().then(() => {
  const filename = path.resolve(__dirname, '../apps/desktop/src/main/editor-context-menu.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require });
  let corrected, added, handler;
  const window = { webContents: {
    replaceMisspelling: word => { corrected = word; },
    session: { addWordToSpellCheckerDictionary: word => { added = word; return true; } },
    on: (name, callback) => { assert.equal(name, 'context-menu'); handler = callback; },
  }};
  const params = { isEditable: true, misspelledWord: 'squigle', dictionarySuggestions: ['squiggle'],
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } };
  const menu = exports.createEditorContextMenu(window, params);
  assert.equal(menu.items[0].label, 'squiggle');
  menu.items[0].click();
  assert.equal(corrected, 'squiggle');
  menu.items.find(item => item.label === 'Add to dictionary').click();
  assert.equal(added, 'squigle');
  assert.equal(menu.items.find(item => item.role === 'redo').enabled, false);
  for (const role of ['undo', 'cut', 'copy', 'paste', 'selectall']) assert(menu.items.some(item => item.role === role));
  const noSuggestions = exports.createEditorContextMenu(window, {...params, dictionarySuggestions: []});
  assert.equal(noSuggestions.items[0].enabled, false);
  assert.equal(noSuggestions.items[0].label, 'No spelling suggestions');
  const ordinary = exports.createEditorContextMenu(window, {...params, misspelledWord: '', dictionarySuggestions: []});
  assert.equal(ordinary.items[0].role, 'undo');
  assert.equal(exports.createEditorContextMenu(window, {...params, isEditable: false}), null);
  exports.installEditorContextMenu(window);
  assert.equal(typeof handler, 'function');
  handler({}, {...params, isEditable: false});
  const output = path.resolve(__dirname, '../artifacts/ux-verification/native-editor-menu.json');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify({passed:true, suggestions:true, dictionaryAction:true, editingRoles:true, nonEditableIgnored:true}, null, 2));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
