import { chooseSelectOption, openSelect } from "./select-option.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const { page, errors, close } = await fixture({ imageCount: 0, threadCount: 0, viewport: { width: 1440, height: 920 } });
const sidebar = page.getByRole("complementary", { name: "Fern navigation" });
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const item = (name, root) => root.getByRole("menuitem", { name, exact: true });
const folder = (name) => button(name, sidebar);
const folderMenu = async (name) => {
  await button(`Actions for folder ${name}`, sidebar).click();
  return page.getByRole("menu", { name: `Actions for ${name}`, exact: true });
};
const saveFolder = async (dialogName, name, submit = "Create folder") => {
  const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await button(submit, dialog).click();
  await folder(name).waitFor();
};
const expectLocation = (name, parent, kind) => expect.poll(async () => {
  const workspace = await savedTextWorkspace(page);
  const folders = workspace?.folders ?? [];
  const expected = parent ? folders.find(({ name }) => name === parent)?.id : undefined;
  if (parent && !expected) return false;
  const row = kind === "folder"
    ? folders.find((folder) => folder.name === name)
    : workspace?.threads.find((thread) => thread.title === name);
  return !!row && (kind === "folder" ? row.parentId : row.folderId) === expected;
}).toBe(true);

try {
  await sidebar.locator(".sidebar-new-button").click();
  await page.getByRole("menu", { name: "New thread type", exact: true })
    .getByRole("menuitem", { name: "Chat folder", exact: true }).click();
  await saveFolder("New chat folder", "Research");
  const newFolder = button("New chat folder", sidebar);
  await newFolder.click();
  const createDialog = page.getByRole("dialog", { name: "New chat folder", exact: true });
  await expect(createDialog.getByRole("textbox", { name: "Folder name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);
  await expect(newFolder).toBeFocused();
  await newFolder.click();
  await saveFolder("New chat folder", "Writing");
  await item("New subfolder", await folderMenu("Research")).click();
  await saveFolder("New subfolder", "Sources");
  await expectLocation("Sources", "Research", "folder");

  await item("New chat here", await folderMenu("Sources")).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep these local notes.");
  await button("Actions for text thread New text thread", sidebar).click();
  await item("Rename", page.getByRole("menu", { name: "Actions for New text thread", exact: true })).click();
  const name = sidebar.getByRole("textbox", { name: "Text thread name" });
  await expect(name).toBeFocused();
  await name.fill("Local notes");
  await name.press("Enter");
  const chat = button("Text thread: Local notes", sidebar);
  await expectLocation("Local notes", "Sources", "chat");

  await item("Move to folder…", await folderMenu("Sources")).click();
  const moveFolder = page.getByRole("dialog", { name: "Move folder", exact: true });
  await chooseSelectOption(moveFolder.getByRole("combobox", { name: "Destination for Sources" }), "Writing");
  await button("Move", moveFolder).click();
  await expectLocation("Sources", "Writing", "folder");
  await item("Move to folder…", await folderMenu("Writing")).click();
  const choices = moveFolder.getByRole("combobox", { name: "Destination for Writing" });
  assert.deepEqual(await (await openSelect(choices)).getByRole("option").allTextContents(), ["Chats (top level)", "Research"]);
  await page.keyboard.press("Escape");
  await expect(moveFolder).toBeVisible();
  await expect(choices).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button("Actions for folder Writing", sidebar)).toBeFocused();

  await item("Rename", await folderMenu("Writing")).click();
  await saveFolder("Rename folder", "Studio plans", "Save name");
  await folder("Sources").dragTo(folder("Research"));
  await expectLocation("Sources", "Research", "folder");
  await folder("Sources").dragTo(folder("Studio plans"));
  await expectLocation("Sources", "Studio plans", "folder");
  await folder("Studio plans").click();
  await chat.waitFor({ state: "hidden" });
  await expect.poll(async () => (await savedTextWorkspace(page))?.folders?.find(({ name }) => name === "Studio plans")?.collapsed).toBe(true);
  await page.reload();
  await folder("Studio plans").waitFor();
  assert.equal(await folder("Studio plans").getAttribute("aria-expanded"), "false");
  await chat.waitFor({ state: "hidden" });
  await button("Search threads", sidebar).click();
  const search = page.getByRole("dialog", { name: "Search threads", exact: true });
  await search.getByRole("searchbox", { name: "Find a thread" }).fill("studio plans / sources");
  await search.getByRole("button", { name: /Local notes Studio plans \/ Sources/ }).click();
  await chat.waitFor();
  assert.equal(await composer.inputValue(), "Keep these local notes.");

  await page.keyboard.press("Control+k");
  const commands = page.getByRole("combobox", { name: "Search commands or threads" });
  await commands.fill("studio plans / sources");
  await page.getByRole("option", { name: /Local notes Chat · Studio plans \/ Sources/ }).waitFor();
  await page.keyboard.press("Escape");

  await chat.dragTo(sidebar.locator(".sidebar-chat-heading"));
  await expectLocation("Local notes", null, "chat");
  await chat.dragTo(folder("Research"));
  await expectLocation("Local notes", "Research", "chat");
  await page.reload();
  await chat.waitFor();
  assert.equal(await composer.inputValue(), "Keep these local notes.");

  await button("Actions for text thread Local notes", sidebar).click();
  await item("Move to folder…", page.getByRole("menu", { name: "Actions for Local notes", exact: true })).click();
  const moveChat = page.getByRole("dialog", { name: "Move chat", exact: true });
  await chooseSelectOption(moveChat.getByRole("combobox", { name: "Destination for Local notes" }), "Studio plans");
  await button("Move", moveChat).click();
  await expectLocation("Local notes", "Studio plans", "chat");
  const folderIcon = await folder("Sources").locator("svg").last().boundingBox();
  const chatIcon = await chat.locator("svg").first().boundingBox();
  assert(Math.abs(folderIcon.x - chatIcon.x) < 1, "Sibling folders and chats should align on the same icon column.");

  await item("Delete folder", await folderMenu("Studio plans")).click();
  const remove = page.getByRole("dialog", { name: "Delete folder", exact: true });
  await button("Delete folder", remove).click();
  await folder("Studio plans").waitFor({ state: "hidden" });
  await expectLocation("Local notes", null, "chat");
  await expectLocation("Sources", null, "folder");
  assert.equal(await composer.inputValue(), "Keep these local notes.");
  assert.deepEqual(errors, []);
  console.log("Chat folder creation, nesting, keyboard moves, drag-and-drop, search, persistence, and safe deletion passed.");
} finally {
  await close();
}
