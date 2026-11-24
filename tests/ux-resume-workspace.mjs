import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const { page, errors, dir, close } = await fixture({ imageCount: 0, threadCount: 0, platform: "linux", viewport: { width: 1440, height: 920 } });
const add = async (name) => {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
};
try {
  for (const name of ["Create image", "Chat", "Create speech"]) {
    for (let index = 0; index < 3; index++) await add(name);
  }
  await page.waitForFunction(() => {
    const keys = ["fern-threads:v1", "fern-qwen3-tts-threads:v1"];
    return keys.every((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.threads.length === 1);
  });
  await page.screenshot({ path: `${dir}/03-empty-speech-threads-linux-fixture-light-1440x920.png` });

  assert.equal((await savedTextWorkspace(page)).threads.length, 1);
  const now = Date.now();
  await savedTextWorkspace(page, {
      activeId: "text-thread-newest", threads: [
        { id: "text-thread-newest", title: "Poster", draft: "Newer draft", messages: [
          { id: "response-poster", role: "assistant", content: "Hold the Atlas rehearsal on Friday.", createdAt: now },
        ], updatedAt: now },
        { id: "text-thread-earlier", title: "Poster", draft: "Earlier draft", messages: [], updatedAt: now - 120_000 },
        { id: "text-thread-archived", title: "Poster", archived: true, messages: [], updatedAt: now - 60_000 },
        { id: "text-thread-renamed", title: "Named empty draft", renamed: true, messages: [], updatedAt: now },
        { id: "text-thread-exact", title: "Local conversation", renamed: true, messages: [], updatedAt: now - 240_000 },
        { id: "text-thread-cafe", title: "Café ideas", renamed: true, messages: [], updatedAt: now - 240_000 },
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `text-thread-conversation-${index}`,
          title: `Local conversation ${index}`,
          renamed: true, messages: [], updatedAt: now - index,
        })),
      ],
  });
  await page.reload();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search commands or threads" });
  const activeOption = page.getByRole("option", { selected: true });
  await expect(activeOption).toHaveAttribute("id", /^command-thread-/);
  await search.fill("local conversation");
  await expect(activeOption).toHaveAttribute("id", "command-thread-text-thread-exact");
  for (let index = 0; index < 15; index++) await search.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Commands and threads" });
  assert(await list.evaluate((element) => element.scrollTop > 0), "Keyboard selection scrolls through broader results");
  await search.fill("  video   open ");
  await expect(activeOption).toContainText("Open Video");
  assert.equal(await list.evaluate((element) => element.scrollTop), 0, "A new query scrolls back to its best result");
  await search.fill("ideas cafe\u0301");
  await expect(activeOption).toHaveAttribute("id", "command-thread-text-thread-cafe");
  await search.fill("Atlas rehearsal");
  await expect(activeOption).toContainText("Search all threads");
  await search.fill("poster");
  const matches = page.getByRole("group", { name: "Recent threads" }).getByRole("option");
  assert.equal(await matches.count(), 2);
  assert.notEqual(await matches.first().innerText(), await matches.last().innerText());
  await matches.first().hover();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector('.command-palette-action:hover')?.getAttribute("aria-selected") === "false");
  const [hovered, selected] = await matches.evaluateAll(items => items.map(item => ({
    width: item.getBoundingClientRect().width,
    fill: getComputedStyle(item).backgroundColor,
    selected: item.getAttribute("aria-selected"),
  })));
  assert.equal(selected.selected, "true");
  assert.equal(hovered.width, selected.width);
  assert.notEqual(hovered.fill, selected.fill, "The parked pointer must not mask the keyboard-selected result");
  await page.screenshot({ path: `${dir}/command-palette-threads-linux-fixture-light-1440x920.png` });
  await page.keyboard.press("Enter");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Earlier draft");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Control+k");
  await search.waitFor();
  assert.equal(await search.inputValue(), "");
  await search.fill("poster");
  await matches.nth(1).waitFor();
  await matches.first().and(page.locator('[aria-selected="true"]')).waitFor();
  await search.press("ArrowDown");
  await matches.nth(1).and(page.locator('[aria-selected="true"]')).waitFor();
  await search.press("ArrowDown");
  await page.getByRole("option", { name: /Search all threads/, selected: true }).waitFor();
  await search.press("Enter");
  await page.getByRole("dialog", { name: "Search threads", exact: true }).waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Find a thread" }).inputValue(), "poster");
  await page.getByLabel("Archived only").check();
  assert.equal(await page.locator(".thread-browser-list article").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Text thread: Named empty draft", exact: true }).waitFor();
  await expect.poll(async () => (await savedTextWorkspace(page)).activeId).toBe("text-thread-earlier");
  await page.reload();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Earlier draft");

  await page.setViewportSize({ width: 864, height: 547 });
  const sidebar = page.getByRole("complementary", { name: "Fern navigation" });
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
  const earlierRow = sidebar.locator('[data-thread-id="text-thread-earlier"]');
  const newerRow = sidebar.locator('[data-thread-id="text-thread-newest"]');
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  assert.equal(await earlierRow.count(), 0);
  const workspace = page.getByRole("main");
  const workspaceBounds = await workspace.boundingBox();
  await composer.focus();
  await composer.press("Control+b");
  await earlierRow.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-thread-id") === "text-thread-earlier");
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await workspace.boundingBox(), workspaceBounds, "The overlay must keep the workspace in place");
  assert.equal(await composer.inputValue(), "Earlier draft");
  await page.screenshot({ path: `${dir}/compact-history-light-864x547.png` });
  await page.keyboard.press("Escape");
  await expand.waitFor();
  assert(await composer.evaluate((element) => document.activeElement === element));

  const switchChat = page.getByRole("button", { name: "Open text thread", exact: true });
  await switchChat.press("Enter");
  const chatSearch = page.getByRole("dialog", { name: "Search chats", exact: true });
  const chatQuery = chatSearch.getByRole("searchbox", { name: "Find a chat", exact: true });
  await expect(chatQuery).toBeFocused();
  await chatQuery.fill("Poster");
  const chatMatches = chatSearch.locator(".thread-browser-open");
  await expect(chatMatches).toHaveCount(2);
  await expect(chatSearch.locator('[aria-current="true"]')).toContainText("Earlier draft");
  await chatSearch.getByLabel("Archived only").check();
  await expect(chatMatches).toHaveCount(1);
  await expect(chatMatches.first()).toContainText("Archived");
  await chatSearch.getByLabel("Archived only").uncheck();
  await chatQuery.fill("Atlas rehearsal");
  await chatQuery.press("Enter");
  await expect(composer).toHaveValue("Newer draft");
  const findInChat = page.getByRole("searchbox", { name: "Search this chat", exact: true });
  await expect(findInChat).toHaveValue("Atlas rehearsal");
  await expect(findInChat).toBeFocused();
  await findInChat.press("Escape");
  await switchChat.press("Enter");
  await chatQuery.fill("Earlier draft");
  await chatQuery.press("Enter");
  await expect(composer).toHaveValue("Earlier draft");

  await expand.click();
  await sidebar.getByRole("button", { name: "Search threads", exact: true }).click();
  const threadSearch = page.getByRole("dialog", { name: "Search threads", exact: true });
  await threadSearch.waitFor();
  await page.keyboard.press("Escape");
  await threadSearch.waitFor({ state: "hidden" });
  assert(await earlierRow.isVisible(), "Dismissing the nested search must leave the drawer open");
  await sidebar.getByRole("button", { name: "New thread", exact: true }).click();
  const newThreadMenu = page.getByRole("menu", { name: "New thread type", exact: true });
  await newThreadMenu.waitFor();
  await page.keyboard.press("Escape");
  await newThreadMenu.waitFor({ state: "hidden" });
  assert(await collapse.isVisible(), "Escape in the new thread menu should close only the menu");
  const threadActions = earlierRow.locator("..").getByRole("button", { name: "Actions for text thread Poster" });
  await threadActions.press("ArrowDown");
  const actions = page.getByRole("menu", { name: "Actions for Poster", exact: true });
  await expect(actions.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(actions.getByRole("menuitem", { name: "Delete", exact: true })).toBeFocused();
  assert(await actions.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  }), "The thread menu should fit within the compact window");
  await page.screenshot({ path: `${dir}/compact-sidebar-thread-actions.png` });
  await page.keyboard.press("Escape");
  await actions.waitFor({ state: "hidden" });
  await expect(threadActions).toBeFocused();
  assert(await collapse.isVisible(), "Escape in thread actions should close only the menu");

  await newerRow.press("Enter");
  await expand.waitFor();
  assert.equal(await composer.inputValue(), "Newer draft");
  await page.waitForFunction(() => document.activeElement?.id === "main-content");
  await expand.click();
  await earlierRow.click();
  await expand.waitFor();
  assert.equal(await composer.inputValue(), "Earlier draft");
  assert.equal(await page.evaluate(() => localStorage.getItem("fern-sidebar-collapsed")), "false");

  await expand.click();
  await page.locator(".sidebar-overlay-scrim").click({ position: { x: 430, y: 80 } });
  await expand.waitFor();
  assert(await expand.evaluate((element) => document.activeElement === element));
  await sidebar.getByRole("button", { name: "New thread", exact: true }).press("ArrowDown");
  const newImageAction = newThreadMenu.getByRole("menuitem", { name: "Create image", exact: true });
  await newImageAction.waitFor();
  assert(await newImageAction.getByText("Create image", { exact: true }).isVisible(), "The compact New menu should show its action labels");
  await page.keyboard.press("Escape");
  await newImageAction.waitFor({ state: "hidden" });
  assert(await collapse.isVisible());
  await page.keyboard.press("Escape");
  await expand.waitFor();
  await expand.click();
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.locator(".sidebar-overlay-scrim").waitFor({ state: "hidden" });
  await earlierRow.waitFor();
  assert.equal(await page.locator(".sidebar-overlay-scrim").count(), 0);
  await collapse.click();
  assert.equal(await earlierRow.count(), 0);
  await page.setViewportSize({ width: 800, height: 491 });
  await expand.click();
  await earlierRow.waitFor();
  await page.reload();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Earlier draft");
  assert(await expand.isVisible(), "The transient drawer must reopen closed after relaunch");
  await page.setViewportSize({ width: 1440, height: 920 });
  assert(await expand.isVisible(), "Keep the user's wide-window preference");
  assert.deepEqual(errors, []);
  console.log("Untouched drafts, duplicate-title search, archives, compact navigation and workspace restoration passed.");
} finally {
  await close();
}
