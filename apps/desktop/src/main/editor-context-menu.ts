import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

export function createEditorContextMenu(window: BrowserWindow, params: ContextMenuParams): Menu | null {
  if (!params.isEditable) return null;
  const contents = window.webContents;
  const items: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
    } else {
      items.push({ label: "No spelling suggestions", enabled: false });
    }
    items.push({
      label: "Add to dictionary",
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    }, { type: "separator" });
  }
  const flags = params.editFlags;
  items.push(
    { role: "undo", enabled: flags.canUndo },
    { role: "redo", enabled: flags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: flags.canCut },
    { role: "copy", enabled: flags.canCopy },
    { role: "paste", enabled: flags.canPaste },
    { role: "selectAll", enabled: flags.canSelectAll },
  );
  return Menu.buildFromTemplate(items);
}

export function installEditorContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    createEditorContextMenu(window, params)?.popup({ window });
  });
}
