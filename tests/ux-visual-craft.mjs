import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, dir, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 864, height: 576 },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const chat = page.getByRole("textbox", { name: "Message", exact: true });

try {
  await chat.waitFor();
  await button("Create speech").waitFor();
  await page.getByRole("link", { name: "Skip to workspace", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "main-content");
  assert.equal(await page.locator(".sidebar-audio-threads").count(), 0);
  assert.equal(await page.getByRole("region", { name: "Image threads", exact: true }).count(), 0);
  await page.keyboard.press("Control+k");
  const commands = page.getByRole("dialog", { name: "Commands", exact: true });
  await expect(commands.getByRole("option", { selected: true })).toContainText("Create image");
  await expect(commands.getByRole("group", { name: "Recent threads" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await chat.fill("Keep this first conversation draft.");
  await page.reload();
  await chat.waitFor();
  assert.equal(await chat.inputValue(), "Keep this first conversation draft.");
  await page.keyboard.press("Control+k");
  const recent = commands.getByRole("group", { name: "Recent threads" }).getByRole("option");
  await expect(recent).toHaveCount(1);
  await expect(recent.first()).toContainText("New text thread");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${dir}/design-chat-first-run.png` });

  await button("Create image").click();
  const imagePrompt = page.getByRole("textbox", { name: "Image prompt", exact: true });
  await imagePrompt.waitFor();
  await imagePrompt.fill("A short prompt");
  const layout = await page.evaluate(() => ({
    composer: document.querySelector(".prompt-composer").getBoundingClientRect(),
    text: document.querySelector("#prompt").getBoundingClientRect(),
  }));
  assert(layout.composer.height < 100, `Excessive one-line height: ${layout.composer.height}`);
  await imagePrompt.fill("Line one\nLine two\nLine three\nLine four");
  assert((await imagePrompt.boundingBox()).height > layout.text.height + 30, "The editor should grow with its content");
  await imagePrompt.fill("A short prompt");
  const ring = () => page.locator(".prompt-composer").evaluate((el) => ({
    color: getComputedStyle(el).outlineColor,
    width: getComputedStyle(el).outlineWidth,
  }));
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await button("Toggle theme").click();
    await imagePrompt.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert(await imagePrompt.evaluate((el) => el.matches(":focus-visible")));
    const focus = await ring();
    assert.equal(focus.width, "2px");
    assert.equal(focus.color, theme === "light" ? "rgb(33, 104, 181)" : "rgb(106, 175, 255)");
    await page.screenshot({ path: `${dir}/design-compact-image-${theme}.png` });
  }
  await page.reload();
  await imagePrompt.waitFor();
  assert.equal(await imagePrompt.inputValue(), "A short prompt");
  assert.deepEqual(errors, []);
  console.log("Fresh chat entry, quiet sidebar, draft restoration, growing image composer and both themes passed.");
} finally {
  await close();
}

const loaded = await fixture({ viewport: { width: 864, height: 576 }, threadCount: 3 });
try {
  const { page: loadedPage, state: loadedState } = loaded;
  const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#efdfc0"/><circle cx="256" cy="256" r="140" fill="#b83e2c"/></svg>';
  loadedState.images = loadedState.images.map((image) => ({
    ...image,
    url: "data:image/svg+xml," + encodeURIComponent(poster),
    width: 512,
    height: 512,
  }));
  await loadedPage.reload();
  const image = loadedPage.locator(".stage-image");
  await image.waitFor();
  await loadedPage.waitForFunction(() => document.querySelector(".stage-image")?.naturalWidth === 512);
  for (const viewport of [{ width: 864, height: 576 }, { width: 1080, height: 720 }, { width: 1440, height: 920 }]) {
    await loadedPage.setViewportSize(viewport);
    const dimensions = await loadedPage.evaluate(() => {
      const img = document.querySelector(".stage-image").getBoundingClientRect();
      const output = document.querySelector(".output-preview-area").getBoundingClientRect();
      const actions = document.querySelector(".output-bar").getBoundingClientRect();
      const metadata = document.querySelector(".output-name").getBoundingClientRect();
      const save = document.querySelector(".output-bar .image-actions > button").getBoundingClientRect();
      return {
        preview: img.height, actionsBottom: actions.bottom, stageBottom: output.bottom,
        outputCenterDifference: Math.abs(metadata.y + metadata.height / 2 - save.y - save.height / 2),
      };
    });
    assert(dimensions.preview >= 195, `Preview too small at ${viewport.width}: ${dimensions.preview}`);
    assert(dimensions.actionsBottom <= dimensions.stageBottom + 1, `Output actions clip at ${viewport.width}`);
    assert(dimensions.outputCenterDifference < 1, `Output dimensions should align with actions at ${viewport.width}px`);
    if (viewport.width === 864) await loadedPage.screenshot({ path: `${loaded.dir}/design-compact-image-with-output.png` });
  }
  await loadedPage.setViewportSize({ width: 864, height: 547 });
  const switcher = loadedPage.getByRole("button", { name: "Open thread", exact: true });
  await loadedPage.getByRole("heading", { name: "Stable title", exact: true }).waitFor();
  await switcher.press("Enter");
  const imageSearch = loadedPage.getByRole("dialog", { name: "Search image threads", exact: true });
  const imageQuery = imageSearch.getByRole("searchbox", { name: "Find an image thread", exact: true });
  await expect(imageQuery).toBeFocused();
  await imageQuery.fill("Study number 1");
  await imageQuery.press("Enter");
  const switchedTitle = loadedPage.getByRole("heading", { name: "Study number 1", exact: true });
  await switchedTitle.waitFor();
  await expect(switcher).toBeFocused();
  assert((await switchedTitle.boundingBox()).height >= 16, "The compact workspace must retain its visible title");
  assert.equal((await switcher.boundingBox()).width, 32);
  assert.deepEqual(loaded.errors, []);
  console.log("Loaded square preview and output controls fit at three desktop viewport sizes.");
} finally {
  await loaded.close();
}
