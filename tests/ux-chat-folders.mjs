import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const { page, errors, close } = await fixture({ imageCount: 0, threadCount: 0, viewport: { width: 1440, height: 920 } });
const sidebar = page.getByRole("complementary", { name: "Fern navigation" });
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const folder = (name) => button(name, sidebar);
const folderMenu = async (name) => {
  await button(`Actions for folder ${name}`, sidebar).click();
  return page.getByRole("group", { name: `Actions for ${name}`, exact: true });
};
const saveFolder = async (dialogName, name, submit = "Create folder") => {
  const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name" });
  await input.fill(name);
  await button(submit, dialog).click();
  await folder(name).waitFor();
};
const expectLocation = (name, parent, kind) => page.waitForFunction(({ name, parent, kind }) => {
  const workspace = JSON.parse(localStorage.getItem("fern-text-threads:v1") ?? "null");
  const folders = workspace?.folders ?? [];
  const expected = parent ? folders.find(({ name }) => name === parent)?.id : undefined;
  if (parent && !expected) return false;
  const row = kind === "folder"
    ? folders.find((folder) => folder.name === name)
    : workspace?.threads.find((thread) => thread.title === name);
  return row && (kind === "folder" ? row.parentId : row.folderId) === expected;
}, { name, parent, kind });

try {
  await sidebar.locator(".sidebar-new-button").click();
  await sidebar.getByRole("menuitem", { name: "Chat folder", exact: true }).click();
  await saveFolder("New chat folder", "Research");
  await button("New chat folder", sidebar).click();
  await saveFolder("New chat folder", "Writing");
  await button("New subfolder", await folderMenu("Research")).click();
  await saveFolder("New subfolder", "Sources");
  await expectLocation("Sources", "Research", "folder");

  await button("New chat here", await folderMenu("Sources")).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep these local notes.");
  await button("Actions for text thread New text thread", sidebar).click();
  await button("Rename", page.getByRole("group", { name: "Actions for New text thread", exact: true })).click();
  const name = sidebar.getByRole("textbox", { name: "Text thread name" });
  await name.fill("Local notes");
  await name.press("Enter");
  const chat = button("Text thread: Local notes", sidebar);
  await expectLocation("Local notes", "Sources", "chat");

  await button("Move to folder…", await folderMenu("Sources")).click();
  const moveFolder = page.getByRole("dialog", { name: "Move folder", exact: true });
  await moveFolder.getByRole("combobox", { name: "Destination for Sources" }).selectOption({ label: "Writing" });
  await button("Move", moveFolder).click();
  await expectLocation("Sources", "Writing", "folder");
  await button("Move to folder…", await folderMenu("Writing")).click();
  const choices = moveFolder.getByRole("combobox", { name: "Destination for Writing" });
  assert.deepEqual(await choices.locator("option").allTextContents(), ["Chats (top level)", "Research"]);
  await page.keyboard.press("Escape");

  await button("Rename", await folderMenu("Writing")).click();
  await saveFolder("Rename folder", "Studio plans", "Save name");
  await folder("Sources").dragTo(folder("Research"));
  await expectLocation("Sources", "Research", "folder");
  await folder("Sources").dragTo(folder("Studio plans"));
  await expectLocation("Sources", "Studio plans", "folder");
  await folder("Studio plans").click();
  await chat.waitFor({ state: "hidden" });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("fern-text-threads:v1")).folders
    .find(({ name }) => name === "Studio plans")?.collapsed);
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
  await button("Move to folder…", page.getByRole("group", { name: "Actions for Local notes", exact: true })).click();
  const moveChat = page.getByRole("dialog", { name: "Move chat", exact: true });
  await moveChat.getByRole("combobox", { name: "Destination for Local notes" }).selectOption({ label: "Studio plans" });
  await button("Move", moveChat).click();
  await expectLocation("Local notes", "Studio plans", "chat");
  const folderIcon = await folder("Sources").locator("svg").last().boundingBox();
  const chatIcon = await chat.locator("svg").first().boundingBox();
  assert(Math.abs(folderIcon.x - chatIcon.x) < 1, "Sibling folders and chats should align on the same icon column.");

  await button("Delete folder", await folderMenu("Studio plans")).click();
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
