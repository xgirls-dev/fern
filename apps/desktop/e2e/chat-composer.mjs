import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { savedTextWorkspace } from "../../../tests/ui-fixture.mjs";

export async function verifyChatComposer(page) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-chat-input-"));
  let session;
  const pickerPath = path.join(scratch, "Inspection notes.txt");
  const dropPath = path.join(scratch, "Color notes.md");
  try {
    session = await page.context().newCDPSession(page);
    await writeFile(pickerPath, "Review the glaze under daylight.");
    await writeFile(dropPath, "# Color notes\n\nThe glaze reads copper.");

    const button = (name) => page.getByRole("button", { name, exact: true });
    await page.locator(".sidebar-new-menu").getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const composeForm = page.locator(".text-composer");
    const documents = page.getByRole("list", { name: "Chat documents", exact: true });
    await expect(composer).toBeFocused();

    // Drive Chromium's editing pipeline with trusted input, without choosing an OS IME.
    await composer.pressSequentially("First line");
    await composer.press("Shift+Enter");
    await composer.evaluate((field) => {
      field.dataset.compositionEvents = "";
      for (const eventName of ["compositionstart", "compositionupdate", "compositionend"]) {
        field.addEventListener(eventName, (event) => {
          if (event.isTrusted) field.dataset.compositionEvents += eventName + " ";
        });
      }
    });
    await session.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await expect(composer).toHaveValue("First line\nにほんご");
    await session.send("Input.insertText", { text: "日本語" });
    await expect(composer).toHaveValue("First line\n日本語");
    await expect(composer).toHaveAttribute("data-composition-events", /^compositionstart compositionupdate /);

    await session.send("Input.imeSetComposition", { text: "ひらがな", selectionStart: 4, selectionEnd: 4 });
    await expect(composer).toHaveValue("First line\n日本語ひらがな");
    await session.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    const draft = "First line\n日本語";
    await expect(composer).toHaveValue(draft);

    await composer.press("ArrowLeft");
    const caret = await composer.evaluate((field) => field.selectionStart);
    const attach = button("Attach documents");
    async function pick(files) {
      const [opened] = await Promise.all([page.waitForEvent("filechooser"), attach.press("Enter")]);
      await opened.setFiles(files);
    }
    await pick([]);
    await expect(documents).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    await pick(pickerPath);
    await expect(documents).toContainText("Inspection notes.txt");
    await expect(composer).toBeFocused();
    await expect.poll(() => composer.evaluate((field) => field.selectionStart)).toBe(caret);

    const readActive = async () => {
      const workspace = await savedTextWorkspace(page);
      return workspace?.threads.find(({ id }) => id === workspace.activeId);
    };
    await expect.poll(async () => (await readActive())?.documents?.length).toBe(1);
    const workspace = await savedTextWorkspace(page);
    await savedTextWorkspace(page, { ...workspace, threads: workspace.threads.map((thread) =>
      thread.id === workspace.activeId ? { ...thread, draftContextImage: "copper-sample.png" } : thread) });
    await page.reload();
    await expect(button("Remove selected conversation image")).toBeVisible();
    await expect(button("Attach chat image")).toBeDisabled();
    await expect(attach).toBeEnabled();

    const area = await composer.boundingBox();
    if (!area) throw new Error("The chat composer needs to be onscreen for the drop.");
    const drop = { x: area.x + area.width / 2, y: area.y + area.height / 2,
      data: { items: [], files: [dropPath], dragOperationsMask: 1 } };
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
    await expect(composeForm).toHaveClass(/\bis-file-over\b/);
    await session.send("Input.dispatchDragEvent", { type: "drop", ...drop });
    await expect(composeForm).not.toHaveClass(/\bis-file-over\b/);
    await expect(documents).toContainText("Color notes.md");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await readActive())?.documents?.length).toBe(2);
    await page.reload();
    await expect(composer).toHaveValue(draft);
    await expect(documents).toContainText("Inspection notes.txt");
    await expect(documents).toContainText("Color notes.md");
    console.log("Chat composer passed: Chromium IME commit and cancel, multiline input, document chooser, caret, and file drop.");
  } finally {
    try {
      await session?.detach();
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}
